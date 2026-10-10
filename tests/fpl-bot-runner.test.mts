import assert from "node:assert/strict";
import test from "node:test";
import { botD1 } from "./helpers/bot-d1.mts";
import { detectPreFirstDeadline, observedHitPoints, runBotTick, type TickDeps } from "../app/lib/fpl-bot/runner.ts";
import { importBotKey } from "../app/lib/fpl-bot/crypto.ts";
import { BotFplClient, BotHttpError } from "../app/lib/fpl-bot/fpl-client.ts";
import { canonicalSquad, hashString } from "../app/lib/fpl-bot/hash.ts";
import {
  claimRun, getRun, readBotAuthRow, readBotState, recentErrors, setBotKill, setBotMode, setDryRunPassed, storeBotBootstrap, setBotIdentity, updateRun, recordPost, countPosts,
} from "../app/lib/fpl-bot/store.ts";
import type { FplData } from "../app/lib/fpl.ts";
import type { BotEnv } from "../app/lib/fpl-bot/config.ts";

// No test in this file can reach FPL: every request goes through `fakeFetch`, which records it and THROWS on any POST.
const BOT = "4242";
const KEY = Buffer.alloc(32, 9).toString("base64");
const ENV: BotEnv = { FPL_EDGE_BOT_FPL_ENTRY_ID: BOT, FPL_EDGE_BOT_TOKEN_KEY: KEY, FPL_EDGE_PERSONAL_FPL_ENTRY_ID: "1111" };
const NOW = Date.parse("2026-10-10T08:00:00Z");
const SQUAD = Array.from({ length: 15 }, (_, i) => i + 1);
const myTeam = (squad = SQUAD) => ({
  picks: squad.map((element, i) => ({ element, position: i + 1, multiplier: i < 11 ? 1 : 0, is_captain: i === 0, is_vice_captain: i === 1, selling_price: 50, purchase_price: 50 })),
  transfers: { bank: 0, limit: 1, made: 0, cost: 0 },
  chips: [],
});

type Call = { method: string; url: string };
function fakeFetch(opts: { meEntry?: string | null; team?: unknown } = {}) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    if (method === "POST") throw new Error(`TEST VIOLATION: POST to ${url}`);
    if (url.endsWith("/api/me/")) return new Response(JSON.stringify({ player: opts.meEntry === undefined ? { entry: Number(BOT) } : opts.meEntry === null ? null : { entry: Number(opts.meEntry) } }), { status: 200 });
    if (url.includes("/api/my-team/")) return new Response(JSON.stringify(opts.team ?? myTeam()), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { calls, impl };
}

async function connectedDb(identity: string | null = BOT) {
  const { db } = botD1();
  const key = await importBotKey(KEY);
  // Access token valid for hours => keep-alive never needs PingOne (no network).
  await storeBotBootstrap(db, key, { refreshToken: "rt-test", accessToken: "at-test", accessExpiresAtMs: Date.now() + 6 * 3_600_000 }, identity ?? BOT, NOW - 86_400_000);
  if (identity === null) await setBotIdentity(db, null, NOW);
  return db;
}

const data = (deadline: number) => ({ events: [{ id: 8, name: "Gameweek 8", deadline: new Date(deadline).toISOString(), finished: false, current: false, next: true }], players: [], fixtures: [], teams: [] }) as unknown as FplData;

function deps(db: TickDeps["db"], f: ReturnType<typeof fakeFetch>, over: Partial<TickDeps> = {}): TickDeps & { loads: number[] } {
  const loads: number[] = [];
  return {
    env: ENV,
    db,
    loadData: async () => {
      loads.push(1);
      return data(NOW + 120 * 60_000);
    },
    fetchPublicJson: async (url) => {
      if (url.includes("bootstrap-static")) throw new Error("no bootstrap in tests");
      return null;
    },
    fetchImpl: f.impl,
    now: () => NOW,
    sleep: async () => {},
    log: () => {},
    loads,
    ...over,
  };
}

const posts = (f: ReturnType<typeof fakeFetch>) => f.calls.filter((c) => c.method === "POST");

test("unconfigured bot: shadow, no network, no POST", async () => {
  const { db } = botD1();
  const f = fakeFetch();
  const s = await runBotTick(deps(db, f, { env: {} }));
  assert.equal(s.ran, true);
  assert.equal(s.mode?.effective, "shadow");
  assert.equal(f.calls.length, 0);
  assert.match((await readBotState(db)).last_tick_summary ?? "", /no bot entry/);
});

test("wrong-account rejection: /api/me reports another entry => kill switch set, no data, no POST", async () => {
  const db = await connectedDb(null);
  const f = fakeFetch({ meEntry: "1111" });
  const d = deps(db, f);
  const s = await runBotTick(d);
  assert.equal(s.mode?.effective, "off");
  assert.ok(s.errors.includes("identity-mismatch"));
  const state = await readBotState(db);
  assert.equal(state.kill, 1);
  assert.match(state.kill_reason ?? "", /identity-mismatch/);
  assert.equal((await readBotAuthRow(db))?.identity_entry, null);
  assert.equal(d.loads.length, 0);
  assert.equal(posts(f).length, 0);
  assert.ok(!f.calls.some((c) => c.url.includes("/my-team/")), "never reads a team the token is not proven to own");
});

test("unknown identity (no player) is treated like a mismatch", async () => {
  const db = await connectedDb(null);
  const f = fakeFetch({ meEntry: null });
  const s = await runBotTick(deps(db, f));
  assert.ok(s.errors.includes("identity-unknown"));
  assert.equal((await readBotState(db)).kill, 1);
});

test("kill switch: mode off, no plan, no POST even when live was requested", async () => {
  const db = await connectedDb();
  await setBotMode(db, "live", NOW);
  await setDryRunPassed(db, BOT, NOW);
  await setBotKill(db, true, "owner", NOW);
  const f = fakeFetch();
  const d = deps(db, f);
  const s = await runBotTick(d);
  assert.equal(s.mode?.effective, "off");
  assert.deepEqual(s.mode?.reasons, ["kill-switch"]);
  assert.equal(d.loads.length, 0);
  assert.equal(posts(f).length, 0);
});

test("do-nothing fallback: official data unavailable while live => error logged, no POST", async () => {
  const db = await connectedDb();
  await setBotMode(db, "live", NOW);
  await setDryRunPassed(db, BOT, NOW);
  const f = fakeFetch();
  const s = await runBotTick(deps(db, f, { loadData: async () => { throw new Error("upstream down"); } }));
  assert.equal(s.mode?.effective, "live");
  assert.ok(s.errors.includes("data-unavailable"));
  assert.equal(posts(f).length, 0);
  assert.ok((await recentErrors(db)).some((e) => e.code === "data-unavailable"));
});

test("do-nothing fallback: fresh bootstrap unavailable in the submit window => lineup step fails safely, no POST", async () => {
  const db = await connectedDb();
  await setBotMode(db, "live", NOW);
  await setDryRunPassed(db, BOT, NOW);
  const f = fakeFetch();
  const s = await runBotTick(deps(db, f));
  assert.equal(s.window, "submit");
  assert.equal(posts(f).length, 0);
  const transfers = await getRun(db, BOT, 8, "transfers");
  assert.equal(transfers?.status, "failed_retryable");
  assert.match(transfers?.error ?? "", /bootstrap/);
});

test("idempotency: an earlier 'posted' transfer whose target matches my-team is verified WITHOUT re-posting", async () => {
  const db = await connectedDb();
  await setBotMode(db, "live", NOW);
  await setDryRunPassed(db, BOT, NOW);
  const row = await claimRun(db, BOT, 8, "transfers", "live", NOW - 3_600_000, 60_000);
  assert.ok(row);
  await updateRun(db, row.id, { status: "posted", target_state_hash: await hashString(canonicalSquad(SQUAD)) }, NOW - 3_600_000);
  const f = fakeFetch();
  await runBotTick(deps(db, f));
  assert.equal((await getRun(db, BOT, 8, "transfers"))?.status, "verified");
  assert.equal(posts(f).length, 0);
});

test("idempotency: an ambiguous earlier transfer (squad != target) stops the gameweek, never re-posts", async () => {
  const db = await connectedDb();
  await setBotMode(db, "live", NOW);
  await setDryRunPassed(db, BOT, NOW);
  const row = await claimRun(db, BOT, 8, "transfers", "live", NOW - 3_600_000, 60_000);
  await updateRun(db, row!.id, { status: "posted", target_state_hash: await hashString(canonicalSquad([...SQUAD.slice(0, 14), 99])) }, NOW - 3_600_000);
  const f = fakeFetch();
  const s = await runBotTick(deps(db, f));
  assert.equal((await getRun(db, BOT, 8, "transfers"))?.status, "failed_ambiguous");
  assert.equal((await readBotState(db)).gw_kill_event, 8);
  assert.ok(s.errors.includes("transfers-ambiguous"));
  assert.equal(posts(f).length, 0);
  assert.equal(await getRun(db, BOT, 8, "lineup"), null, "no lineup step after an ambiguous transfer");
});

test("claimRun: exactly once per (entry, gw, step); leased rows are not stolen; finished rows never re-run", async () => {
  const { db } = botD1();
  const a = await claimRun(db, BOT, 8, "lineup", "live", NOW, 60_000);
  assert.equal(a?.attempt, 1);
  assert.equal(await claimRun(db, BOT, 8, "lineup", "live", NOW + 1_000, 60_000), null, "still leased");
  const stale = await claimRun(db, BOT, 8, "lineup", "live", NOW + 120_000, 60_000);
  assert.equal(stale?.attempt, 2, "a dead tick's claim (never posted) can be taken over after the lease");
  await updateRun(db, stale!.id, { status: "verified", lease_until: null }, NOW);
  assert.equal(await claimRun(db, BOT, 8, "lineup", "live", NOW + 10 * 3_600_000, 60_000), null);
  await updateRun(db, stale!.id, { status: "posted", lease_until: null }, NOW);
  assert.equal(await claimRun(db, BOT, 8, "lineup", "live", NOW + 10 * 3_600_000, 60_000), null, "'posted' is resolved from my-team, never re-claimed");
});

test("POST accounting feeds the per-GW / per-day caps", async () => {
  const { db } = botD1();
  for (let i = 0; i < 3; i++) await recordPost(db, BOT, 8, "lineup", 200, NOW);
  assert.deepEqual(await countPosts(db, BOT, 8, NOW), { gw: 3, day: 3 });
});

test("BotFplClient: POST refused unless armed; transfer payload for another entry refused; GETs work", async () => {
  const f = fakeFetch();
  const tokens = { getAccessToken: async () => "at" } as unknown as ConstructorParameters<typeof BotFplClient>[0]["tokens"];
  const client = new BotFplClient({ entryId: BOT, tokens, fetchImpl: f.impl, sleep: async () => {} });
  await assert.rejects(() => client.postPicks({ picks: [], chip: null }), (e: unknown) => e instanceof BotHttpError && e.code === "post-disabled");
  client.armPosts(true);
  await assert.rejects(() => client.postTransfers({ entry: 1111, event: 8, chip: null, confirmed: true, transfers: [] } as never), /not the bot entry/);
  client.armPosts(false);
  assert.equal((await client.me()).entry, BOT);
  assert.equal(posts(f).length, 0);
  assert.throws(() => new BotFplClient({ entryId: "abc", tokens, fetchImpl: f.impl }));
});

test("pre-first-deadline detection needs limit null + no pending chip + public started_event == next event", async () => {
  const pub = (started: number) => ({ fetchPublicJson: async () => ({ id: Number(BOT), started_event: started }) });
  const t = (limit: number | null, pending = false) => ({ ...myTeam(), transfers: { bank: 0, limit, made: 0 }, chips: pending ? [{ name: "wildcard", is_pending: true }] : [] });
  assert.equal(await detectPreFirstDeadline(pub(6), BOT, t(null), 6), true);
  assert.equal(await detectPreFirstDeadline(pub(5), BOT, t(null), 6), false, "already past its first deadline (WC/FH window)");
  assert.equal(await detectPreFirstDeadline(pub(6), BOT, t(1), 6), false);
  assert.equal(await detectPreFirstDeadline(pub(6), BOT, t(null, true), 6), false, "pending chip");
  assert.equal(await detectPreFirstDeadline({ fetchPublicJson: async () => { throw new Error("down"); } }, BOT, t(null), 6), false);
  assert.equal(await detectPreFirstDeadline({ fetchPublicJson: async () => ({ id: 1, started_event: 6 }) }, BOT, t(null), 6), false, "wrong entry");
});

test("observedHitPoints: spent_points wins; unlimited => 0; else (made - limit) x 4; unknown => null", () => {
  const t = (limit: number | null, made: number) => ({ ...myTeam(), transfers: { bank: 0, limit, made } });
  assert.equal(observedHitPoints(t(1, 3), { spent_points: 0 }), 0);
  assert.equal(observedHitPoints(t(null, 9), null), 0);
  assert.equal(observedHitPoints(t(1, 2), null), 4);
  assert.equal(observedHitPoints(t(2, 1), {}), 0);
  assert.equal(observedHitPoints({ ...myTeam(), transfers: { bank: 0, limit: undefined as unknown as number, made: 0 } }, null), null);
});

test("never reads the public picks endpoint: unverified session => no action, no public team fallback", async () => {
  const { db } = botD1();
  const f = fakeFetch();
  const urls: string[] = [];
  const d = deps(db, f, { env: { ...ENV, FPL_EDGE_BOT_TOKEN_KEY: undefined }, fetchPublicJson: async (u) => { urls.push(u); return null; } });
  const s = await runBotTick(d);
  assert.equal(s.mode?.effective, "shadow");
  assert.ok(!urls.some((u) => u.includes("/picks/")));
  assert.match((await readBotState(db)).last_tick_summary ?? "", /not connected/);
});

test("BotFplClient default fetch is not invoked as a method (Workers 'Illegal invocation')", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = function (this: unknown, input: RequestInfo | URL) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    calls++;
    void input;
    return Promise.resolve(new Response(JSON.stringify({ player: { entry: Number(BOT) } }), { status: 200 }));
  } as typeof fetch;
  try {
    const tokens = { getAccessToken: async () => "at" } as unknown as ConstructorParameters<typeof BotFplClient>[0]["tokens"];
    const client = new BotFplClient({ entryId: BOT, tokens, sleep: async () => {} });
    assert.equal((await client.me()).entry, BOT);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("normal GW (not a new team): live in the plan window never claims transfers", async () => {
  const db = await connectedDb();
  await setBotMode(db, "live", NOW);
  await setDryRunPassed(db, BOT, NOW);
  const f = fakeFetch();
  const d = deps(db, f, { loadData: async () => data(NOW + 10 * 3_600_000), fetchPublicJson: async (u) => { if (u.includes("bootstrap")) throw new Error("no bootstrap"); return { id: Number(BOT), started_event: 1 }; } });
  const s = await runBotTick(d);
  assert.equal(s.window, "plan");
  assert.equal(await getRun(db, BOT, 8, "transfers"), null);
  assert.equal(posts(f).length, 0);
});

test("final window: no transfers (outside D-2h), lineup only", async () => {
  const db = await connectedDb();
  await setBotMode(db, "live", NOW);
  await setDryRunPassed(db, BOT, NOW);
  const f = fakeFetch();
  const s = await runBotTick(deps(db, f, { loadData: async () => data(NOW + 60 * 60_000) }));
  assert.equal(s.window, "final");
  assert.ok(s.actions.some((a) => a.includes("lineup only")));
  assert.equal(await getRun(db, BOT, 8, "transfers"), null);
  assert.equal(posts(f).length, 0);
});

test("submit window but under D-2h (e.g. D-100min): transfers skipped, lineup attempted", async () => {
  const db = await connectedDb();
  await setBotMode(db, "live", NOW);
  await setDryRunPassed(db, BOT, NOW);
  const f = fakeFetch();
  const s = await runBotTick(deps(db, f, { loadData: async () => data(NOW + 100 * 60_000) }));
  assert.equal(s.window, "submit");
  assert.equal(await getRun(db, BOT, 8, "transfers"), null);
  assert.ok((await getRun(db, BOT, 8, "lineup")) !== null, "lineup step ran (and failed safely without bootstrap)");
  assert.equal(posts(f).length, 0);
});

test("revoked refresh family: ONE token exchange, classified token-expired, token-free OIDC detail stored", async () => {
  const { db } = botD1();
  const key = await importBotKey(KEY);
  // Access expired => keep-alive must refresh exactly once with the stored (rotated) refresh token.
  await storeBotBootstrap(db, key, { refreshToken: "rt-stored-rotated", accessToken: "at-old", accessExpiresAtMs: Date.now() - 60_000 }, BOT, NOW - 3_600_000);
  const tokenBodies: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://account.premierleague.com/as/token") {
      tokenBodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token reused; family revoked eyJabc.def.ghi" }), { status: 400 });
    }
    if ((init?.method ?? "GET").toUpperCase() === "POST") throw new Error(`TEST VIOLATION: POST to ${url}`);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const summary = await runBotTick(deps(db, { calls: [], impl }));
  assert.equal(summary.auth, "token-expired");
  assert.equal(tokenBodies.length, 1, "exactly one PingOne exchange - no retry loop that could look like reuse");
  assert.match(tokenBodies[0], /refresh_token=rt-stored-rotated/);
  const err = (await recentErrors(db)).find((e) => e.code === "auth-token-expired");
  assert.ok(err?.detail, "detail recorded");
  assert.match(err!.detail!, /oidc 400 invalid_grant/);
  assert.match(err!.detail!, /family revoked/);
  assert.doesNotMatch(err!.detail!, /rt-stored-rotated|eyJabc/);
  assert.equal((await readBotAuthRow(db))?.last_error, "token-expired");
});

test("bookmarklet removes the FPL browser's copy of the session after reading it (no browser reuse of a spent token)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../app/bot/page.tsx", import.meta.url), "utf8");
  const js = src.slice(src.indexOf("const js = `"), src.indexOf("return `javascript:${js}`"));
  const read = js.indexOf("localStorage.getItem(k)");
  const removed = js.indexOf("localStorage.removeItem(k)");
  const leave = js.indexOf("location=");
  assert.ok(read > 0 && removed > read && leave > removed, "read, then delete, then navigate away");
  assert.match(js, /sessionStorage\.removeItem/);
});
