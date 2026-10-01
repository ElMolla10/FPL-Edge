/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles over node:sqlite rows and partial snapshots */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { FplData, FplPlayer } from "../app/lib/fpl.ts";
import { buildExampleSquad } from "../app/lib/example-squad.ts";
import { CALL_HASH_VERSION, canonicalCallString, computeCanonicalCall, flagToken, hashCall, isExampleSquadIds, parsePreviousCall, serializeCall, type CanonicalCall } from "../app/lib/call-alerts/call.ts";
import { MAX_EMAILS_PER_UTC_DAY_WITH_NEW_FLAG, decideSend, utcDate } from "../app/lib/call-alerts/policy.ts";
import { OFF_SENTENCE, composeEmail, composeSubject, escapeHtml } from "../app/lib/call-alerts/email.ts";
import { RESEND_API_BASE, createResendTransport, readAlertConfig, resolveResendBaseUrl, validSender, type MailMessage, type MailTransport } from "../app/lib/call-alerts/resend.ts";
import { runCallAlerts, type AlertDb } from "../app/lib/call-alerts/run.ts";
import { parseNotificationPrefsBody, readNotificationPrefs, writeNotifyOptIn } from "../app/lib/notification-prefs.ts";
import { BodyError } from "../app/lib/request-guards.ts";

(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };

// ------------------------------------------------------------------ synthetic official snapshot ---
function makePlayer(o: Partial<FplPlayer> & { id: number }): FplPlayer {
  return {
    name: `P${o.id}`, firstName: "T", secondName: `P${o.id}`, teamId: o.id, teamName: `Team ${o.id}`, teamShort: `T${o.id}`, positionId: 3, position: "MID", positionShort: "MID",
    price: 5, status: "a", chance: null, epNext: 3, form: 3, pointsPerGame: 3, priorPointsPerGame: 3, priorMinutes: 2500, priorStarts: 30, priorExpectedGoals: 3, priorExpectedAssists: 3, priorBonus: 10,
    priorSaves: 0, priorPenaltiesSaved: 0, priorDefensiveContribution: 100, priorSource: "official-pl-history", totalPoints: 0, eventPoints: 0, eventMinutes: 0, eventBonus: 0, eventDefensiveContribution: 0,
    selectedBy: 10, priceChange: 0, priceProjectionToday: 0, priceChangeSinceStart: 0, priceOutlook: [], transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0,
    expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 0, starts: 0, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0,
    penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0, penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
    ...o,
  } as FplPlayer;
}
const SQUAD_IDS = [1, 2, 11, 12, 13, 14, 15, 21, 22, 23, 24, 25, 31, 32, 33];
function pool(): FplPlayer[] {
  const p = (id: number, positionId: number, short: string, price: number, epNext: number) => makePlayer({ id, positionId, position: short, positionShort: short, price, epNext });
  return [
    p(1, 1, "GKP", 4.5, 3.5), p(2, 1, "GKP", 4.5, 3.4), p(3, 1, "GKP", 4.5, 3.0), p(4, 1, "GKP", 5, 3.8),
    ...[11, 12, 13, 14, 15, 16, 17, 18].map((id, i) => p(id, 2, "DEF", 4.5 + (i % 3) * 0.5, 3 + (i % 4) * 0.4)),
    ...[21, 22, 23, 24, 25, 26, 27, 28].map((id, i) => p(id, 3, "MID", 5 + (i % 4), 3.2 + (i % 5) * 0.7)),
    ...[31, 32, 33, 34, 35].map((id, i) => p(id, 4, "FWD", 6 + (i % 3), 3.4 + (i % 4) * 0.6)),
  ];
}
function dataFor(players = pool()): FplData {
  const events = Array.from({ length: 5 }, (_, i) => ({ id: i + 7, name: `Gameweek ${i + 7}`, deadline: "2099-01-01T00:00:00Z", current: false, next: i === 0, finished: false, dataChecked: false }));
  const clubs = [...new Set(players.map((p) => p.teamId))];
  const fixtures = events.flatMap((e) => clubs.map((teamId, i) => ({ id: e.id * 1000 + i, event: e.id, teamH: teamId, teamA: 1000 + teamId, teamHDifficulty: 3, teamADifficulty: 3, finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null })));
  return {
    updatedAt: "2026-10-01T00:00:00Z", source: "test", seasonStatsThrough: 0, players, fixtures, events, teams: clubs.map((id) => ({ id, name: `Team ${id}`, short: `T${id}` })),
    rules: { budget: 100, squadSize: 15, teamLimit: 3, positions: [
      { id: 1, name: "Goalkeeper", short: "GKP", squad: 2, minPlay: 1, maxPlay: 1 }, { id: 2, name: "Defender", short: "DEF", squad: 5, minPlay: 3, maxPlay: 5 },
      { id: 3, name: "Midfielder", short: "MID", squad: 5, minPlay: 2, maxPlay: 5 }, { id: 4, name: "Forward", short: "FWD", squad: 3, minPlay: 1, maxPlay: 3 }] },
  } as unknown as FplData;
}
const manager = (over: Record<string, unknown> = {}) => ({ id: 1, name: "T", teamName: "T", overallPoints: 0, overallRank: 0, gameweekPoints: 0, gameweekRank: 0, squadValue: 70, bank: 0.5, bankSource: "entry-history", rankingFinance: "ready", transfersMade: 0, transferCost: 0, freeTransferLimit: null, captainId: null, viceCaptainId: null, chip: null, ...over }) as any;
const input = (data: FplData, ids = SQUAD_IDS, m = manager()) => ({ data, squadIds: ids, manager: m, captainVice: {} });

// ------------------------------------------------------------------ canonical call + hash ---
test("canonical call: same squad + same data -> identical call and identical hash (stable across runs)", async () => {
  const a = computeCanonicalCall(input(dataFor()));
  const b = computeCanonicalCall(input(dataFor()));
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.deepEqual(a.call, b.call);
  assert.equal(await hashCall(a.call), await hashCall(b.call));
  assert.match(await hashCall(a.call), /^[0-9a-f]{64}$/);
  assert.equal(a.call.gw, 7);
  assert.ok(a.call.decision === "HOLD" || a.call.decision === "MAKE");
});

test("hash input is exactly gameweek + decision + captain + out + in + flag fingerprint (versioned)", () => {
  const call: CanonicalCall = { gw: 6, decision: "MAKE", captainId: 5, outId: 7, inId: 9, flags: ["3:d:50", "8:i:0"] };
  assert.equal(canonicalCallString(call), `${CALL_HASH_VERSION};6;MAKE;5;7;9;3:d:50|8:i:0`);
  assert.equal(canonicalCallString({ ...call, decision: "HOLD", outId: null, inId: null, flags: [] }), `${CALL_HASH_VERSION};6;HOLD;5;0;0;`);
});

test("an official flag change flips the hash even when the transfer decision stays HOLD", async () => {
  const hold: CanonicalCall = { gw: 6, decision: "HOLD", captainId: 5, outId: null, inId: null, flags: [] };
  const flagged: CanonicalCall = { ...hold, flags: ["21:d:50"] };
  const worse: CanonicalCall = { ...hold, flags: ["21:d:25"] };
  assert.notEqual(await hashCall(hold), await hashCall(flagged));
  assert.notEqual(await hashCall(flagged), await hashCall(worse));
  assert.equal(await hashCall(flagged), await hashCall({ ...flagged }));
  // and end-to-end through the real pipeline: flagging a squad player changes the flag set, hence the hash
  const base = computeCanonicalCall(input(dataFor()));
  const players = pool().map((p) => (p.id === 22 ? { ...p, status: "d", chance: 50 } : p));
  const flaggedRun = computeCanonicalCall(input(dataFor(players)));
  assert.ok(base.ok && flaggedRun.ok);
  if (!base.ok || !flaggedRun.ok) return;
  assert.deepEqual(base.call.flags, []);
  assert.deepEqual(flaggedRun.call.flags.filter((f) => f.startsWith("22:")), ["22:d:50"]);
  assert.notEqual(await hashCall(base.call), await hashCall(flaggedRun.call));
});

test("flagToken: only real official flags count (status != a, or chance < 100)", () => {
  assert.equal(flagToken(makePlayer({ id: 1 })), null);
  assert.equal(flagToken(makePlayer({ id: 1, chance: 100 })), null);
  assert.equal(flagToken(makePlayer({ id: 2, status: "d", chance: 75 })), "2:d:75");
  assert.equal(flagToken(makePlayer({ id: 3, status: "i", chance: 0 })), "3:i:0");
  assert.equal(flagToken(makePlayer({ id: 4, status: "a", chance: 50 })), "4:a:50");
});

test("live bank unavailable (personal overlay failed) -> no call is invented; example XV -> no call", () => {
  const unavailable = computeCanonicalCall(input(dataFor(), SQUAD_IDS, manager({ rankingFinance: "unavailable", bankSource: "unavailable", bank: null, liveOverlayError: "token-expired" })));
  assert.deepEqual(unavailable, { ok: false, reason: "bank-unavailable" });
  const data = dataFor();
  const example = buildExampleSquad(data).map((p) => p.id);
  assert.equal(isExampleSquadIds(data, example), true);
  assert.deepEqual(computeCanonicalCall(input(data, example)), { ok: false, reason: "example-squad" });
  assert.equal(isExampleSquadIds(data, SQUAD_IDS), false);
  assert.deepEqual(computeCanonicalCall(input(data, SQUAD_IDS.slice(0, 14))), { ok: false, reason: "incomplete-squad" });
});

test("serialize/parse previous call round trips ids only", () => {
  const call: CanonicalCall = { gw: 6, decision: "MAKE", captainId: 5, outId: 7, inId: 9, flags: ["1:d:50"] };
  const json = serializeCall(call);
  assert.doesNotMatch(json, /d:50/);
  assert.deepEqual(parsePreviousCall(json), { gw: 6, decision: "MAKE", captainId: 5, outId: 7, inId: 9 });
  assert.equal(parsePreviousCall("nope"), null);
  assert.equal(parsePreviousCall(null), null);
});

// ------------------------------------------------------------------ daily cap policy ---
const NOW = Date.parse("2026-10-01T10:00:00Z");
const empty = { lastCallHash: null, emailsSentUtcDate: null, emailsSentToday: 0, lastFlagFingerprint: null };

test("policy: first evaluation sends; unchanged hash never sends", () => {
  assert.equal(decideSend(empty, "h1", [], NOW).send, true);
  assert.deepEqual(decideSend({ ...empty, lastCallHash: "h1" }, "h1", [], NOW), { send: false, reason: "unchanged" });
});

test("policy: DAILY CAP blocks a second non-flag email the same UTC day, allows it the next UTC day", () => {
  const sentToday = { lastCallHash: "h1", emailsSentUtcDate: utcDate(NOW), emailsSentToday: 1, lastFlagFingerprint: "" };
  assert.deepEqual(decideSend(sentToday, "h2", [], NOW), { send: false, reason: "daily-cap" });
  assert.equal(decideSend(sentToday, "h2", [], NOW + 24 * 3_600_000).send, true);
  // a UTC midnight boundary: 23:59Z vs 00:01Z are different days even though 2 minutes apart
  const late = Date.parse("2026-10-01T23:59:00Z");
  const early = Date.parse("2026-10-02T00:01:00Z");
  const s = { ...sentToday, emailsSentUtcDate: utcDate(late) };
  assert.equal(decideSend(s, "h2", [], late).send, false);
  assert.equal(decideSend(s, "h2", [], early).send, true);
});

test("policy: a NEW official flag allows a second email the same day, but never a third", () => {
  const first = { lastCallHash: "h1", emailsSentUtcDate: utcDate(NOW), emailsSentToday: 1, lastFlagFingerprint: "" };
  const second = decideSend(first, "h2", ["21:d:50"], NOW);
  assert.deepEqual(second, { send: true, newFlag: true, sentToday: 1, today: utcDate(NOW) });
  const afterSecond = { lastCallHash: "h2", emailsSentUtcDate: utcDate(NOW), emailsSentToday: MAX_EMAILS_PER_UTC_DAY_WITH_NEW_FLAG, lastFlagFingerprint: "21:d:50" };
  assert.deepEqual(decideSend(afterSecond, "h3", ["21:d:50", "30:i:0"], NOW), { send: false, reason: "daily-cap" });
  // an already-emailed flag is not "new": a captain/transfer change with the same flags stays capped
  assert.deepEqual(decideSend({ ...first, lastFlagFingerprint: "21:d:50" }, "h2", ["21:d:50"], NOW), { send: false, reason: "daily-cap" });
  // a flag that disappears is not a flag appearing
  assert.deepEqual(decideSend({ ...first, lastFlagFingerprint: "21:d:50" }, "h2", [], NOW), { send: false, reason: "daily-cap" });
});

// ------------------------------------------------------------------ email copy ---
test("email copy: only call, captain, one-line why, app-shell link, and the settings sentence", () => {
  const call: CanonicalCall = { gw: 6, decision: "MAKE", captainId: 5, outId: 7, inId: 9, flags: [] };
  const detail = { captainName: "B.Fernandes", outName: "Raya", inName: "Kelleher", reason: "Clears the bar.\nSecond line", wildcard: false, flagged: [] };
  const email = composeEmail({ call, detail, previous: { gw: 6, decision: "HOLD", captainId: 5, outId: null, inId: null }, newFlag: false, siteUrl: "https://fpl-edge.elmolla10.workers.dev" });
  assert.equal(email.subject, "FPL Edge · GW6 call changed: Raya → Kelleher");
  assert.equal(email.link, "https://fpl-edge.elmolla10.workers.dev/?app=1");
  assert.match(email.text, /GW6 call: Raya → Kelleher/);
  assert.match(email.text, /Captain: B\.Fernandes/);
  assert.match(email.text, /Why: Clears the bar\. Second line/);
  assert.match(email.text, /\/\?app=1/);
  assert.ok(email.text.includes(OFF_SENTENCE));
  assert.ok(email.html.includes(OFF_SENTENCE));
  assert.doesNotMatch(email.text + email.html, /season pass|upgrade|discount|unsubscribe|pixel|<img/i);
  const hold = composeEmail({ call: { ...call, decision: "HOLD", outId: null, inId: null }, detail: { ...detail, outName: null, inName: null }, previous: null, newFlag: false, siteUrl: "https://x.example.invalid" });
  assert.equal(hold.subject, "FPL Edge · GW6 call: HOLD");
  assert.match(hold.text, /GW6 call: HOLD/);
});

test("email copy: flag subject names the flagged player and the captain; HTML is escaped", () => {
  const call: CanonicalCall = { gw: 6, decision: "HOLD", captainId: 9, outId: null, inId: null, flags: ["3:d:50"] };
  const detail = { captainName: "B.Fernandes", outName: null, inName: null, reason: "Hold <b>x</b>", wildcard: false, flagged: [{ token: "3:d:50", id: 3, name: "Saka", label: "doubtful" }] };
  const prev = { gw: 6, decision: "HOLD" as const, captainId: 3, outId: null, inId: null };
  const subject = composeSubject({ call, detail, previous: prev, newFlag: true, siteUrl: "" });
  assert.equal(subject, "FPL Edge · GW6 flag: Saka doubtful — captain is now B.Fernandes");
  const email = composeEmail({ call, detail, previous: prev, newFlag: true, siteUrl: "" });
  assert.doesNotMatch(email.html, /<b>x<\/b>/);
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

// ------------------------------------------------------------------ Resend config / transport safety ---
test("sender must be on a domain we control (never workers.dev); missing secrets -> not configured, no throw", () => {
  assert.equal(validSender("FPL Edge <alerts@mail.example.invalid>"), true);
  assert.equal(validSender("alerts@example.invalid"), true);
  assert.equal(validSender("alerts@fpl-edge.elmolla10.workers.dev"), false);
  assert.equal(validSender("FPL Edge <alerts@x.pages.dev>"), false);
  assert.equal(validSender("not-an-address"), false);
  assert.equal(validSender(undefined), false);
  assert.deepEqual(readAlertConfig({}, "https://s.example.invalid"), { ok: false, reason: "missing-secrets" });
  assert.deepEqual(readAlertConfig({ RESEND_API_KEY: "k" }, "https://s.example.invalid"), { ok: false, reason: "missing-secrets" });
  assert.deepEqual(readAlertConfig({ RESEND_API_KEY: "k", RESEND_FROM: "a@x.workers.dev" }, "https://s.example.invalid"), { ok: false, reason: "invalid-from" });
  const ok = readAlertConfig({ RESEND_API_KEY: "k", RESEND_FROM: "FPL Edge <a@example.invalid>" }, "https://s.example.invalid");
  assert.ok(ok.ok && ok.config.baseUrl === RESEND_API_BASE && ok.config.siteUrl === "https://s.example.invalid");
});

test("dev Resend base-URL override cannot redirect production mail", () => {
  const evil = "http://evil.example.invalid:9999";
  assert.equal(resolveResendBaseUrl({ FPL_EDGE_DEV_RESEND_BASE_URL: "http://127.0.0.1:9999" }), RESEND_API_BASE, "ignored without the dev flag");
  assert.equal(resolveResendBaseUrl({ FPL_EDGE_DEV_MODE: "1", FPL_EDGE_DEV_RESEND_BASE_URL: evil }), RESEND_API_BASE, "ignored for non-loopback hosts");
  assert.equal(resolveResendBaseUrl({ FPL_EDGE_DEV_MODE: "1", FPL_EDGE_DEV_RESEND_BASE_URL: "https://127.0.0.1:9999" }), RESEND_API_BASE, "ignored for https/other schemes");
  assert.equal(resolveResendBaseUrl({ FPL_EDGE_DEV_MODE: "1", FPL_EDGE_DEV_RESEND_BASE_URL: "javascript:alert(1)" }), RESEND_API_BASE);
  assert.equal(resolveResendBaseUrl({ FPL_EDGE_DEV_MODE: "1", FPL_EDGE_DEV_RESEND_BASE_URL: "http://127.0.0.1:9999/x" }), "http://127.0.0.1:9999");
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(wrangler, /FPL_EDGE_DEV_|RESEND_/, "no dev flag or secret is ever declared in the deployed config");
});

test("resend transport: POSTs the documented payload and never throws on network failure", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const send = createResendTransport({ apiKey: "re_test_key", from: "FPL Edge <a@example.invalid>", baseUrl: RESEND_API_BASE }, (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: "mock-1" }), { status: 200 });
  }) as unknown as typeof fetch);
  const msg: MailMessage = { to: "user@example.invalid", subject: "s", text: "t", html: "<p>h</p>", idempotencyKey: "k1", settingsUrl: "https://s.example.invalid/?app=1" };
  assert.deepEqual(await send(msg), { ok: true, id: "mock-1" });
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer re_test_key");
  assert.equal(headers["Idempotency-Key"], "k1");
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body.to, ["user@example.invalid"]);
  assert.equal(body.headers["List-Unsubscribe"], "<https://s.example.invalid/?app=1>");
  const rate = createResendTransport({ apiKey: "k", from: "a@example.invalid", baseUrl: RESEND_API_BASE }, (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch);
  assert.deepEqual(await rate(msg), { ok: false, status: 429, error: "resend http 429", fatal: true });
  const down = createResendTransport({ apiKey: "k", from: "a@example.invalid", baseUrl: RESEND_API_BASE }, (async () => { throw new TypeError("boom user@example.invalid"); }) as unknown as typeof fetch);
  const failed = await down(msg);
  assert.equal(failed.ok, false);
  assert.doesNotMatch(JSON.stringify(failed), /user@example\.invalid/, "errors never echo the recipient");
});

// ------------------------------------------------------------------ opt-in persistence (real migration SQL on node:sqlite) ---
function migratedDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users (id text PRIMARY KEY NOT NULL, email text NOT NULL UNIQUE);
    CREATE TABLE squad_data (user_id text PRIMARY KEY NOT NULL, squad_ids text NOT NULL DEFAULT '[]', captain_vice text NOT NULL DEFAULT '{}', entry text, manager text);
  `);
  const migration = readFileSync(new URL("../drizzle/0011_notification_prefs.sql", import.meta.url), "utf8");
  sqlite.exec(migration);
  sqlite.exec(migration); // idempotent: second apply must be a no-op, not an error
  const db: AlertDb & { prepare(q: string): any } = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() { return sqlite.prepare(query).run(...(values as never[])); },
            async all() { return { results: sqlite.prepare(query).all(...(values as never[])) as any[] }; },
            async first() { return (sqlite.prepare(query).get(...(values as never[])) as any) ?? null; },
          };
        },
      };
    },
  };
  return { sqlite, db };
}

test("opt-in defaults to OFF (no row, and the column default is 0); migration is idempotent and journaled", async () => {
  const { sqlite, db } = migratedDb();
  sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@example.invalid')").run();
  assert.deepEqual(await readNotificationPrefs(db, "u1"), { notifyCallChanges: false, hasConnectedTeam: false });
  sqlite.prepare("INSERT INTO notification_prefs (user_id) VALUES ('u1')").run();
  const row = sqlite.prepare("SELECT * FROM notification_prefs WHERE user_id='u1'").get() as any;
  assert.equal(row.notify_call_changes, 0);
  assert.equal(row.emails_sent_today, 0);
  assert.equal(row.last_call_hash, null);
  const cols = (sqlite.prepare("PRAGMA table_info(notification_prefs)").all() as any[]).map((c) => c.name);
  for (const c of ["user_id", "notify_call_changes", "last_call_hash", "last_email_at", "emails_sent_utc_date", "last_flag_fingerprint"]) assert.ok(cols.includes(c), c);
  const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  assert.equal(journal.entries.at(-1).tag, "0011_notification_prefs");
  assert.equal(journal.entries.at(-1).idx, 11);
  const schema = readFileSync(new URL("../db/schema.ts", import.meta.url), "utf8");
  assert.match(schema, /notificationPrefs = sqliteTable\("notification_prefs"/);
  assert.match(schema, /notifyCallChanges: integer\("notify_call_changes"\)\.notNull\(\)\.default\(0\)/);
});

test("opt-in toggle persists; turning OFF forgets the last call but keeps the daily counters", async () => {
  const { sqlite, db } = migratedDb();
  sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@example.invalid')").run();
  sqlite.prepare("INSERT INTO squad_data (user_id, entry) VALUES ('u1', '123')").run();
  await writeNotifyOptIn(db, "u1", true, "2026-10-01T00:00:00Z");
  assert.deepEqual(await readNotificationPrefs(db, "u1"), { notifyCallChanges: true, hasConnectedTeam: true });
  sqlite.prepare("UPDATE notification_prefs SET last_call_hash='h', last_call_json='{}', last_flag_fingerprint='1:d:50', emails_sent_utc_date='2026-10-01', emails_sent_today=1 WHERE user_id='u1'").run();
  await writeNotifyOptIn(db, "u1", false, "2026-10-01T01:00:00Z");
  const off = sqlite.prepare("SELECT * FROM notification_prefs WHERE user_id='u1'").get() as any;
  assert.equal(off.notify_call_changes, 0);
  assert.equal(off.last_call_hash, null);
  assert.equal(off.last_flag_fingerprint, null);
  assert.equal(off.emails_sent_today, 1, "off/on must not reset the daily cap");
  await writeNotifyOptIn(db, "u1", true, "2026-10-01T02:00:00Z");
  assert.equal((sqlite.prepare("SELECT emails_sent_today n FROM notification_prefs").get() as any).n, 1);
});

test("settings body validator: exactly one boolean, nothing else", () => {
  assert.deepEqual(parseNotificationPrefsBody({ notifyCallChanges: true }), { notifyCallChanges: true });
  for (const bad of [null, [], "x", {}, { notifyCallChanges: "true" }, { notifyCallChanges: 1 }, { notifyCallChanges: true, userId: "other" }, { notifyCallChanges: true, email: "x" }]) {
    assert.throws(() => parseNotificationPrefsBody(bad), BodyError);
  }
});

// ------------------------------------------------------------------ cron job ---
type Fixture = { sqlite: DatabaseSync; db: AlertDb; sent: MailMessage[]; logs: string[]; transport: MailTransport; teamCalls: number };
function fixture(): Fixture {
  const { sqlite, db } = migratedDb();
  const sent: MailMessage[] = [];
  const logs: string[] = [];
  const transport: MailTransport = async (m) => { sent.push(m); return { ok: true, id: `mock-${sent.length}` }; };
  return { sqlite, db, sent, logs, transport, teamCalls: 0 };
}
function addUser(f: Fixture, id: string, opts: { entry?: string | null; ids?: number[]; optIn?: boolean; email?: string } = {}) {
  f.sqlite.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run(id, opts.email ?? `${id}@example.invalid`);
  f.sqlite.prepare("INSERT INTO squad_data (user_id, squad_ids, entry) VALUES (?, ?, ?)").run(id, JSON.stringify(opts.ids ?? SQUAD_IDS), opts.entry === undefined ? "424242" : opts.entry);
  f.sqlite.prepare("INSERT INTO notification_prefs (user_id, notify_call_changes) VALUES (?, ?)").run(id, opts.optIn === false ? 0 : 1);
}
const ENV = { RESEND_API_KEY: "re_test", RESEND_FROM: "FPL Edge <alerts@example.invalid>" };
let clock = Date.parse("2026-10-01T10:00:00Z");
const run = (f: Fixture, data: FplData, env: Record<string, string> = ENV, over: { m?: any } = {}) =>
  runCallAlerts(env, {
    db: f.db, loadData: async () => data, now: () => clock, sleep: async () => {}, log: (m) => f.logs.push(m), transport: f.transport,
    makeTeamLoader: () => async ({ entry }) => { f.teamCalls++; return { ok: true, manager: over.m ?? manager(), playerIds: JSON.parse((f.sqlite.prepare("SELECT squad_ids s FROM squad_data WHERE user_id = (SELECT user_id FROM squad_data WHERE entry = ? LIMIT 1)").get(entry) as any).s) }; },
  });

test("cron: opted-in user with a real squad gets exactly ONE email on first change, none on rerun", async () => {
  const f = fixture();
  addUser(f, "u1");
  const data = dataFor();
  const first = await run(f, data);
  assert.equal(first.sent, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].to, "u1@example.invalid");
  assert.match(f.sent[0].subject, /^FPL Edge · GW7 call: /);
  assert.match(f.sent[0].idempotencyKey, /^call-alert:u1:[0-9a-f]{24}:2026-10-01$/);
  const row = f.sqlite.prepare("SELECT * FROM notification_prefs WHERE user_id='u1'").get() as any;
  assert.ok(row.last_call_hash && row.last_email_at && row.emails_sent_utc_date === "2026-10-01" && row.emails_sent_today === 1);
  clock += 3_600_000;
  const second = await run(f, data);
  assert.equal(second.sent, 0);
  assert.equal(second.skipped.unchanged, 1);
  assert.equal(f.sent.length, 1);
});

test("cron: a flag appearing on the XV allows a second email the same day; a later non-flag change is capped", async () => {
  const f = fixture();
  addUser(f, "u1");
  clock = Date.parse("2026-10-01T10:00:00Z");
  await run(f, dataFor());
  assert.equal(f.sent.length, 1);
  clock += 3_600_000;
  const flagged = dataFor(pool().map((p) => (p.id === 22 ? { ...p, status: "d", chance: 50 } : p)));
  const afterFlag = await run(f, flagged);
  assert.equal(afterFlag.sent, 1, "flag => second email allowed");
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].subject, /flag: P22 doubtful/);
  clock += 3_600_000;
  // non-flag change (price/expectation shift flips the call) after two sends: capped
  const worse = dataFor(pool().map((p) => (p.id === 22 ? { ...p, status: "d", chance: 50 } : p.id === 33 ? { ...p, epNext: 0.1 } : p)));
  await run(f, worse);
  assert.equal(f.sent.length, 2, "a third email in the same UTC day is never sent");
});

test("cron: daily cap blocks a second NON-flag email for the same user", async () => {
  const f = fixture();
  addUser(f, "u1");
  clock = Date.parse("2026-10-01T10:00:00Z");
  await run(f, dataFor());
  assert.equal(f.sent.length, 1);
  // make the stored last call differ (as if the call had changed) without any flag change
  f.sqlite.prepare("UPDATE notification_prefs SET last_call_hash = 'older-call' WHERE user_id='u1'").run();
  clock += 3_600_000;
  const capped = await run(f, dataFor());
  assert.equal(capped.sent, 0);
  assert.equal(capped.skipped["daily-cap"], 1);
  assert.equal(f.sent.length, 1);
  // next UTC day the (unsent) change goes out
  clock = Date.parse("2026-10-02T00:05:00Z");
  const nextDay = await run(f, dataFor());
  assert.equal(nextDay.sent, 1);
  assert.equal(f.sent.length, 2);
});

test("cron: demo / example squad, not-opted-in, no connected team, and manual-only squads are never emailed", async () => {
  const f = fixture();
  const data = dataFor();
  const example = buildExampleSquad(data).map((p) => p.id);
  addUser(f, "demo", { ids: example });
  addUser(f, "optout", { optIn: false });
  addUser(f, "manual", { entry: null });
  addUser(f, "short", { ids: SQUAD_IDS.slice(0, 10) });
  const summary = await run(f, data);
  assert.equal(summary.sent, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(summary.skipped["example-squad"], 1);
  assert.equal(summary.skipped["no-connected-team"], 1);
  assert.equal(summary.skipped["no-saved-squad"], 1);
  assert.equal(f.teamCalls, 0, "skipped users cost no FPL requests");
  const rows = f.sqlite.prepare("SELECT user_id, last_call_hash, emails_sent_today FROM notification_prefs").all() as any[];
  assert.ok(rows.every((r) => r.last_call_hash === null && r.emails_sent_today === 0), "no notification state written for excluded users");
});

test("cron: unavailable live bank skips the user (no invented call) and logs", async () => {
  const f = fixture();
  addUser(f, "owner");
  const s = await run(f, dataFor(), ENV, { m: manager({ rankingFinance: "unavailable", bankSource: "unavailable", bank: null, liveOverlayError: "token-expired" }) });
  assert.equal(s.sent, 0);
  assert.equal(s.skipped["bank-unavailable"], 1);
  assert.ok(f.logs.some((l) => l.includes("bank-unavailable")));
});

test("cron: MISSING Resend secrets -> no throw, no work, exactly one log line", async () => {
  const f = fixture();
  addUser(f, "u1");
  for (const env of [{}, { RESEND_API_KEY: "k" }, { RESEND_FROM: "a@example.invalid" }]) {
    f.logs.length = 0;
    const summary = await run(f, dataFor(), env as Record<string, string>);
    assert.equal(summary.enabled, false);
    assert.equal(f.sent.length, 0);
    assert.equal(f.teamCalls, 0);
    assert.equal(f.logs.length, 1);
    assert.match(f.logs[0], /disabled/);
  }
  const bad = await run(f, dataFor(), { RESEND_API_KEY: "k", RESEND_FROM: "alerts@x.workers.dev" });
  assert.equal(bad.enabled, false);
  assert.equal((f.sqlite.prepare("SELECT last_checked_at c FROM notification_prefs").get() as any).c, null, "inert: not even last_checked_at is touched");
});

test("cron: a failing send is logged, the rest of the batch still goes out, and a failed user is retried next hour", async () => {
  const f = fixture();
  addUser(f, "bad", { entry: "1" });
  addUser(f, "good", { entry: "2" });
  const failFor = "bad@example.invalid";
  const sent: MailMessage[] = [];
  f.transport = async (m) => (m.to === failFor ? { ok: false, status: 500, error: "resend http 500", fatal: false } : (sent.push(m), { ok: true, id: "x" }));
  const summary = await run(f, dataFor());
  assert.equal(summary.sent, 1);
  assert.equal(summary.failed, 1);
  assert.deepEqual(sent.map((m) => m.to), ["good@example.invalid"]);
  assert.ok(f.logs.some((l) => l.includes("send failed")));
  assert.equal((f.sqlite.prepare("SELECT last_call_hash h FROM notification_prefs WHERE user_id='bad'").get() as any).h, null, "nothing recorded without a successful send");
  f.transport = async (m) => (sent.push(m), { ok: true, id: "y" });
  clock += 3_600_000;
  assert.equal((await run(f, dataFor())).sent, 1);
  assert.deepEqual(sent.map((m) => m.to), ["good@example.invalid", "bad@example.invalid"]);
});

test("cron: a fatal transport error (bad key / 429) stops sending for the run but never throws", async () => {
  const f = fixture();
  addUser(f, "a", { entry: "1" });
  addUser(f, "b", { entry: "2" });
  let attempts = 0;
  f.transport = async () => { attempts++; return { ok: false, status: 401, error: "resend http 401", fatal: true }; };
  const summary = await run(f, dataFor());
  assert.equal(attempts, 1);
  assert.equal(summary.sent, 0);
  assert.equal(summary.skipped["transport-stopped"], 1);
});

test("cron: official snapshot unavailable or table missing -> logged skip, no throw", async () => {
  const f = fixture();
  addUser(f, "u1");
  const s = await runCallAlerts(ENV, { db: f.db, loadData: async () => { throw new Error("fpl down"); }, makeTeamLoader: () => async () => ({ ok: false, reason: "x" }), now: () => clock, sleep: async () => {}, log: (m) => f.logs.push(m), transport: f.transport });
  assert.equal(s.sent, 0);
  assert.ok(f.logs.some((l) => l.includes("snapshot unavailable")));
  f.sqlite.exec("DROP TABLE notification_prefs");
  const t = await run(f, dataFor());
  assert.equal(t.sent, 0);
  assert.ok(f.logs.some((l) => l.includes("cannot read preferences")));
});

// ------------------------------------------------------------------ route + shared-pipeline source guards ---
test("settings route: CSRF, session cookie only, validator, rate limit; GET reports default off", () => {
  const route = readFileSync(new URL("../app/api/account/notifications/route.ts", import.meta.url), "utf8");
  const put = route.slice(route.indexOf("export async function PUT"));
  assert.match(put, /rejectCrossSite\(request\)/);
  assert.match(put, /getCurrentUser\(\)/);
  assert.match(put, /parseNotificationPrefsBody\(/);
  assert.match(put, /consumeSignupAttemptAtomicWith\(/);
  assert.match(put, /status: 429/);
  assert.ok(put.indexOf("rejectCrossSite") < put.indexOf("getCurrentUser") && put.indexOf("getCurrentUser") < put.indexOf("parseNotificationPrefsBody") && put.indexOf("parseNotificationPrefsBody") < put.indexOf("consumeSignupAttemptAtomicWith"));
  assert.doesNotMatch(route, /headers\.get\(["'](x-|authorization)/i, "session cookie only (#80): no header auth");
  assert.match(route, /status: 401/);
  assert.match(route, /no-store/);
});

test("canonical call uses the shared BEST DECISION pipeline (no parallel rule) and documents the choice", () => {
  const call = readFileSync(new URL("../app/lib/call-alerts/call.ts", import.meta.url), "utf8");
  for (const needle of ["rankTransfersForBestDecision(", "selectBestDecision(", "deriveSandboxFinancialContext(", "resolveCaptaincy(", "resolveFreeTransfersFromMeta("]) assert.ok(call.includes(needle), needle);
  assert.match(call, /DECISION CHOICE/);
  const panel = readFileSync(new URL("../app/components/coach/TransfersPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /rankTransfersForBestDecision\(/);
  assert.match(panel, /selectBestDecision\(rows\)/);
  const core = readFileSync(new URL("../app/components/coach/CoachCore.tsx", import.meta.url), "utf8");
  assert.match(core, /from "\.\.\/\.\.\/lib\/best-decision"/);
  const lib = readFileSync(new URL("../app/lib/best-decision.ts", import.meta.url), "utf8");
  const code = lib.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /localStorage|document\.|window\./, "the shared pipeline stays pure");
});

// Private identifiers are assembled from fragments so this test file itself never contains them.
const PII = new RegExp([["imody", "10"].join(""), ["2615", "93"].join("")].join("|"));

test("settings UI: default off, server-persisted, demo-disabled, never localStorage-only; no PII in shipped text", () => {
  const ui = readFileSync(new URL("../app/components/AlertSettings.tsx", import.meta.url), "utf8");
  assert.match(ui, /Email me if the weekly call changes\./);
  assert.match(ui, /\/api\/account\/notifications/);
  assert.doesNotMatch(ui, /localStorage/);
  assert.match(ui, /disabled=\{demo\|\|busy/);
  const shell = readFileSync(new URL("../app/components/CoachApp.tsx", import.meta.url), "utf8");
  assert.match(shell, /<AlertSettings demo=\{exampleActive\}/);
  for (const file of ["app/lib/call-alerts/call.ts", "app/lib/call-alerts/run.ts", "app/lib/call-alerts/email.ts", "app/components/AlertSettings.tsx", "drizzle/0011_notification_prefs.sql"]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, PII, `${file} must not contain private identifiers`);
  }
});
