import assert from "node:assert/strict";
import test from "node:test";
import { assertBotEntry, evaluateBotOwnerGate, parseChipPolicy, parseMode, resolveMode, WrongEntryError, type BotEnv } from "../app/lib/fpl-bot/config.ts";
import { nextActionTick, nextDeadlineEvent, windowFor } from "../app/lib/fpl-bot/schedule.ts";
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
