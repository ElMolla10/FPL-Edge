import assert from "node:assert/strict";
import test from "node:test";
import { assertBotEntry, evaluateBotOwnerGate, parseChipPolicy, parseMode, resolveMode, WrongEntryError, type BotEnv } from "../app/lib/fpl-bot/config.ts";
import { nextActionTick, nextDeadlineEvent, transferPostAllowed, windowFor } from "../app/lib/fpl-bot/schedule.ts";
import { sessionHealth } from "../app/lib/fpl-bot/auth.ts";
import { decryptToken, encryptToken, importBotKey, redact } from "../app/lib/fpl-bot/crypto.ts";
import type { FplEvent } from "../app/lib/fpl.ts";

const ENV: BotEnv = { FPL_EDGE_BOT_FPL_ENTRY_ID: "4242", FPL_EDGE_PERSONAL_FPL_ENTRY_ID: "1111" };
const base = { env: ENV, storedMode: null, kill: false, identityVerified: true, dryRunPassed: true };

test("mode defaults to shadow; live needs entry + verified identity + passed dry run", () => {
  assert.equal(resolveMode({ ...base }).effective, "shadow");
  assert.equal(resolveMode({ ...base, storedMode: "live" }).effective, "live");
  assert.deepEqual(resolveMode({ ...base, storedMode: "live", identityVerified: false }).reasons, ["identity-unverified"]);
  assert.equal(resolveMode({ ...base, storedMode: "live", dryRunPassed: false }).effective, "shadow");
  assert.equal(resolveMode({ ...base, env: { FPL_EDGE_BOT_MODE: "live" }, storedMode: null }).effective, "shadow", "no bot entry => never live");
  assert.equal(resolveMode({ ...base, env: { ...ENV, FPL_EDGE_BOT_MODE: "live" } }).effective, "live", "env var alone can flip live");
});

test("kill switch and env off always win; bot entry == personal entry forces off", () => {
  assert.equal(resolveMode({ ...base, storedMode: "live", kill: true }).effective, "off");
  assert.equal(resolveMode({ ...base, env: { ...ENV, FPL_EDGE_BOT_MODE: "off" }, storedMode: "live" }).effective, "off");
  assert.equal(resolveMode({ ...base, env: { FPL_EDGE_BOT_FPL_ENTRY_ID: "1111", FPL_EDGE_PERSONAL_FPL_ENTRY_ID: "1111" }, storedMode: "live" }).effective, "off");
  assert.equal(parseMode(" LIVE "), "live");
  assert.equal(parseMode("yolo"), null);
});

test("assertBotEntry: only ever the configured bot entry", () => {
  assert.equal(assertBotEntry(ENV), "4242");
  assert.equal(assertBotEntry(ENV, 4242), "4242");
  assert.throws(() => assertBotEntry(ENV, "1111"), WrongEntryError);
  assert.throws(() => assertBotEntry({}), WrongEntryError);
  assert.throws(() => assertBotEntry({ FPL_EDGE_BOT_FPL_ENTRY_ID: "1111", FPL_EDGE_PERSONAL_FPL_ENTRY_ID: "1111" }), WrongEntryError);
  assert.throws(() => assertBotEntry({ FPL_EDGE_BOT_FPL_ENTRY_ID: "12; DROP" }), WrongEntryError);
});

test("owner gate uses its own allowlist", () => {
  const env: BotEnv = { FPL_EDGE_BOT_OWNER_EMAILS: "Owner@Example.com, other@example.com" };
  assert.deepEqual(evaluateBotOwnerGate(env, null), { ok: false, reason: "unauthenticated" });
  assert.deepEqual(evaluateBotOwnerGate(env, "someone@example.com"), { ok: false, reason: "not-owner" });
  assert.deepEqual(evaluateBotOwnerGate(env, "owner@example.com"), { ok: true });
  assert.deepEqual(evaluateBotOwnerGate({}, "owner@example.com"), { ok: false, reason: "not-owner" }, "empty allowlist = nobody");
  assert.equal(parseChipPolicy(undefined), "all");
  assert.equal(parseChipPolicy("cancellable"), "cancellable");
});

test("deadline-relative windows and next tick", () => {
  const d = Date.parse("2026-10-10T10:00:00Z");
  const min = 60_000;
  assert.equal(windowFor(d, d - 30 * 3_600_000), "idle");
  assert.equal(windowFor(d, d - 20 * 3_600_000), "plan");
  assert.equal(windowFor(d, d - 150 * min), "submit");
  assert.equal(windowFor(d, d - 60 * min), "final");
  assert.equal(windowFor(d, d - 10 * min), "locked");
  const next = nextActionTick(d, d - 30 * 3_600_000);
  assert.ok(next && next.atMs % 3_600_000 === 0 && next.atMs > d - 30 * 3_600_000);
  const events = [
    { id: 7, deadline: "2026-10-03T10:00:00Z", finished: true },
    { id: 8, deadline: "2026-10-10T10:00:00Z", finished: false },
    { id: 9, deadline: "2026-10-17T10:00:00Z", finished: false },
  ] as unknown as FplEvent[];
  assert.equal(nextDeadlineEvent(events, d - 1000)?.id, 8);
  assert.equal(nextDeadlineEvent(events, d + 1000)?.id, 9);
});

test("session alert from day 20, multi-step stop from day 28", () => {
  assert.equal(sessionHealth(null), "unknown");
  assert.equal(sessionHealth(19.9), "ok");
  assert.equal(sessionHealth(20), "warn");
  assert.equal(sessionHealth(28), "stop-multistep");
});

test("token crypto round-trips, refuses short keys, and redact strips tokens", async () => {
  const key = await importBotKey(Buffer.alloc(32, 7).toString("base64"));
  const sealed = await encryptToken(key, "secret-refresh");
  assert.ok(!sealed.includes("secret-refresh"));
  assert.equal(await decryptToken(key, sealed), "secret-refresh");
  await assert.rejects(() => importBotKey("short"));
  const r = redact('{"access_token":"eyJabc.def.ghi","x":1}');
  assert.ok(!r.includes("eyJabc.def.ghi"));
});

test("window boundaries: plan opens at D-24h, submit at D-4h, final is the last hour before the 25-min lock", () => {
  const d = Date.parse("2026-10-17T10:00:00Z");
  const at = (minutes: number) => d - minutes * 60_000;
  assert.equal(windowFor(d, at(24 * 60 + 1)), "idle");
  assert.equal(windowFor(d, at(24 * 60)), "plan");
  assert.equal(windowFor(d, at(241)), "plan");
  assert.equal(windowFor(d, at(240)), "submit");
  assert.equal(windowFor(d, at(85)), "submit");
  assert.equal(windowFor(d, at(84.9)), "final");
  assert.equal(windowFor(d, at(25)), "final");
  assert.equal(windowFor(d, at(24.9)), "locked");
});

test("transfer POSTs only between deadline-24h and deadline-2h (never in the final hour or the freeze)", () => {
  const d = Date.parse("2026-10-17T10:00:00Z");
  const at = (minutes: number) => d - minutes * 60_000;
  assert.equal(transferPostAllowed(d, at(24 * 60 + 1)), false, "not before D-24h");
  assert.equal(transferPostAllowed(d, at(24 * 60)), true);
  assert.equal(transferPostAllowed(d, at(240)), true);
  assert.equal(transferPostAllowed(d, at(120)), true);
  assert.equal(transferPostAllowed(d, at(119)), false, "not after D-2h");
  assert.equal(transferPostAllowed(d, at(5)), false);
  assert.equal(transferPostAllowed(d, at(-1)), false);
});

test("hourly ticks: :00 deadlines submit at D-4h with D-3h/D-2h retries; :30 deadlines at D-3.5h/D-2.5h; exactly one final tick", () => {
  const hour = 3_600_000;
  for (const [deadline, transferTicks] of [["2026-10-17T10:00:00Z", 3], ["2026-10-23T17:30:00Z", 2], ["2026-10-30T19:15:00Z", 2], ["2026-11-06T11:45:00Z", 2]] as const) {
    const d = Date.parse(deadline);
    const ticks: number[] = [];
    for (let t = Math.ceil((d - 30 * hour) / hour) * hour; t < d; t += hour) ticks.push(t);
    const submitTransfer = ticks.filter((t) => windowFor(d, t) === "submit" && transferPostAllowed(d, t));
    const finals = ticks.filter((t) => windowFor(d, t) === "final");
    const early = ticks.filter((t) => transferPostAllowed(d, t) && windowFor(d, t) === "plan");
    assert.equal(submitTransfer.length, transferTicks, `${deadline} transfer ticks`);
    assert.equal(finals.length, 1, `${deadline} exactly one final re-pick tick`);
    assert.ok(submitTransfer.every((t) => d - t >= 2 * hour && d - t <= 4 * hour));
    assert.ok(early.length > 0, "plan window ticks exist inside the 24 h window (plan / refresh)");
  }
});
