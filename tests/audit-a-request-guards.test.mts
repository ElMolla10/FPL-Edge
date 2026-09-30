import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BodyError,
  checkSameOrigin,
  parseSquadBody,
  parseStringFields,
  parseTransferExecuteBody,
  readJsonBody,
  rejectCrossSite,
} from "../app/lib/request-guards.ts";

const req = (headers: Record<string, string>, url = "https://fpl-edge.example.workers.dev/api/x") => new Request(url, { method: "POST", headers });

// --- Item 6: CSRF -------------------------------------------------------------------------------

test("checkSameOrigin: Sec-Fetch-Site same-origin / none allowed; cross-site / same-site rejected", () => {
  assert.equal(checkSameOrigin(req({ "sec-fetch-site": "same-origin" })).ok, true);
  assert.equal(checkSameOrigin(req({ "sec-fetch-site": "none" })).ok, true);
  assert.equal(checkSameOrigin(req({ "sec-fetch-site": "cross-site" })).ok, false);
  assert.equal(checkSameOrigin(req({ "sec-fetch-site": "same-site" })).ok, false);
});

test("checkSameOrigin: Sec-Fetch-Site wins over a spoofable-looking Origin", () => {
  assert.equal(checkSameOrigin(req({ "sec-fetch-site": "cross-site", origin: "https://fpl-edge.example.workers.dev" })).ok, false);
});

test("checkSameOrigin: falls back to Origin header (same host ok, other host / scheme / port rejected)", () => {
  assert.equal(checkSameOrigin(req({ origin: "https://fpl-edge.example.workers.dev" })).ok, true);
  assert.equal(checkSameOrigin(req({ origin: "https://evil.example" })).ok, false);
  assert.equal(checkSameOrigin(req({ origin: "http://fpl-edge.example.workers.dev" })).ok, false);
  assert.equal(checkSameOrigin(req({ origin: "https://fpl-edge.example.workers.dev:8443" })).ok, false);
  assert.equal(checkSameOrigin(req({ origin: "https://fpl-edge.example.workers.dev.evil.example" })).ok, false);
  assert.equal(checkSameOrigin(req({ origin: "null" })).ok, false);
});

test("checkSameOrigin: no browser headers at all (curl / server client) is allowed", () => {
  assert.equal(checkSameOrigin(req({})).ok, true);
});

test("rejectCrossSite returns a 403 JSON response only for cross-site requests", async () => {
  assert.equal(rejectCrossSite(req({ "sec-fetch-site": "same-origin" })), null);
  const res = rejectCrossSite(req({ "sec-fetch-site": "cross-site" }));
  assert.equal(res?.status, 403);
  assert.deepEqual(await res?.json(), { error: "Cross-site request blocked." });
});

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) routeFiles(p, out);
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

test("every browser-facing state-changing route handler (POST/PUT/PATCH/DELETE) calls rejectCrossSite first; only the HMAC-authenticated Paymob webhook is exempt", () => {
  const exempt = new Set(["app/api/season-pass/callback/route.ts"]);
  const offenders: string[] = [];
  for (const file of routeFiles(path.join(ROOT, "app/api"))) {
    const rel = path.relative(ROOT, file);
    const src = readFileSync(file, "utf8");
    const m = /export async function (POST|PUT|PATCH|DELETE)\b/.exec(src);
    if (!m) continue;
    if (exempt.has(rel)) continue;
    const bodyStart = src.indexOf("{", m.index);
    const firstStmts = src.slice(bodyStart, bodyStart + 400);
    if (!/rejectCrossSite\(request\)/.test(firstStmts)) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

test("no GET/HEAD route handler mutates state (SECURITY.md claim: no state-changing GETs)", () => {
  const mutation = /\.(insert|update|delete)\(|\.run\(|INSERT INTO|UPDATE \w+ SET|DELETE FROM|persist\w*\(|\.prepare\(|\bset\w*Cookie|Set-Cookie/;
  // Handlers that legitimately reach a write path indirectly are listed with the reason. Currently none.
  const offenders: string[] = [];
  for (const file of routeFiles(path.join(ROOT, "app/api"))) {
    const src = readFileSync(file, "utf8");
    const getMatch = /export (?:async )?function (GET|HEAD)\b|export const (GET|HEAD)\b/.exec(src);
    if (!getMatch) continue;
    // Take the text of the GET handler only: from its declaration to the next exported handler (or EOF).
    const rest = src.slice(getMatch.index);
    const next = rest.slice(10).search(/export (?:async )?function (POST|PUT|PATCH|DELETE)\b/);
    const handler = next === -1 ? rest : rest.slice(0, next + 10);
    const code = handler.replace(/^\s*\/\/.*$/gm, "");
    if (mutation.test(code)) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, []);
});

test("the auth/session-mutating handlers are POST only (login, signup, logout)", () => {
  for (const name of ["login", "signup", "logout"]) {
    const src = readFileSync(path.join(ROOT, `app/api/auth/${name}/route.ts`), "utf8");
    assert.doesNotMatch(src, /export (async )?function GET/);
  }
});

// --- Item 7: body validation --------------------------------------------------------------------

const jsonReq = (body: string, extra: Record<string, string> = {}) => new Request("https://x.test/api", { method: "POST", body, headers: extra });

test("readJsonBody: parses valid JSON, rejects invalid JSON (400) and oversized (413)", async () => {
  assert.deepEqual(await readJsonBody(jsonReq('{"a":1}')), { a: 1 });
  await assert.rejects(() => readJsonBody(jsonReq("{nope")), (e: unknown) => e instanceof BodyError && e.status === 400);
  await assert.rejects(() => readJsonBody(jsonReq(JSON.stringify({ x: "y".repeat(2000) })), 1000), (e: unknown) => e instanceof BodyError && e.status === 413);
  await assert.rejects(() => readJsonBody(jsonReq("{}", { "content-length": "999999" }), 1000), (e: unknown) => e instanceof BodyError && e.status === 413);
});

test("parseStringFields: non-object, wrong types and over-long strings are rejected; absent/null tolerated", () => {
  const spec = { email: 10, password: 10 };
  assert.deepEqual(parseStringFields({ email: "a@b.co", password: "12345678" }, spec), { email: "a@b.co", password: "12345678" });
  assert.deepEqual(parseStringFields({}, spec), {});
  assert.deepEqual(parseStringFields({ email: null }, spec), {});
  for (const bad of [null, [], "str", 5, { email: 1 }, { password: ["x"] }, { email: { $ne: 1 } }, { email: "x".repeat(11) }]) {
    assert.throws(() => parseStringFields(bad, spec), BodyError, JSON.stringify(bad));
  }
});

test("parseSquadBody: accepts the shape the client actually sends (incl. empty defaults)", () => {
  assert.deepEqual(parseSquadBody({}), {});
  const payload = {
    squadIds: [1, 2, 3], watchlist: [10, 20], locks: [{ event: 5, squadIds: [1] }],
    captainVice: { "5": { captainId: 1, viceId: 2 }, "6": { captainId: 0 } },
    entry: "123456", manager: { id: 1, name: "x" }, plans: [{ id: "p" }], plannedChips: [{ event: 9, chip: "wildcard" }],
  };
  const out = parseSquadBody(payload);
  assert.deepEqual(out.squadIds, [1, 2, 3]);
  assert.equal(out.entry, "123456");
  assert.equal(parseSquadBody({ entry: null, manager: null }).entry, null);
  assert.equal(parseSquadBody({ entry: "" }).entry, "");
});

test("parseSquadBody: rejects wrong types, oversized arrays and junk ids", () => {
  const bad: unknown[] = [
    null, [], "x",
    { squadIds: "1,2,3" }, { squadIds: [1, "2"] }, { squadIds: [1.5] }, { squadIds: [-1] }, { squadIds: Array.from({ length: 21 }, (_, i) => i + 1) },
    { watchlist: Array.from({ length: 501 }, (_, i) => i + 1) }, { watchlist: [1e9] },
    { locks: {} }, { locks: Array.from({ length: 61 }, () => ({})) },
    { captainVice: [] }, { captainVice: { abc: {} } }, { captainVice: { "5": { captainId: "1" } } },
    { entry: 123456 }, { entry: "12ab" }, { entry: "1".repeat(17) },
    { manager: "str" }, { manager: [] },
    { plans: {} }, { plans: [1] }, { plannedChips: ["x"] },
    { plans: [{ blob: "z".repeat(1_000_000) }] },
  ];
  for (const b of bad) assert.throws(() => parseSquadBody(b), BodyError, JSON.stringify(b)?.slice(0, 80));
});

test("parseTransferExecuteBody: valid request unchanged (numbers or numeric strings, confirmed optional)", () => {
  assert.deepEqual(parseTransferExecuteBody({ elementOut: 1, elementIn: 2, event: 7, purchasePriceTenths: 55 }), { elementOut: 1, elementIn: 2, event: 7, purchasePriceTenths: 55, confirmed: false });
  assert.equal(parseTransferExecuteBody({ elementOut: "1", elementIn: "2", event: "7", purchasePriceTenths: "55", confirmed: true }).confirmed, true);
});

test("parseTransferExecuteBody: rejects wrong types / non-positive / non-integer / huge / non-boolean confirmed", () => {
  const ok = { elementOut: 1, elementIn: 2, event: 7, purchasePriceTenths: 55 };
  const bad: unknown[] = [
    null, [], "x",
    { ...ok, elementOut: 0 }, { ...ok, elementIn: -3 }, { ...ok, event: 1.5 }, { ...ok, event: 9999 }, { ...ok, purchasePriceTenths: NaN },
    { ...ok, elementOut: "abc" }, { ...ok, elementOut: [] }, { ...ok, elementIn: {} }, { ...ok, elementIn: null }, { ...ok, elementOut: "9".repeat(50) },
    { ...ok, confirmed: "true" }, { ...ok, confirmed: 1 },
    { elementOut: 1 },
  ];
  for (const b of bad) assert.throws(() => parseTransferExecuteBody(b), BodyError, JSON.stringify(b));
});

test("execute route: cross-site check is the FIRST statement, before auth/env/token/FPL work", () => {
  const src = readFileSync(path.join(ROOT, "app/api/personal/fpl-transfer/execute/route.ts"), "utf8");
  const post = src.slice(src.indexOf("export async function POST"));
  assert.ok(post.indexOf("rejectCrossSite(request)") < post.indexOf("readRuntimeEnv()"));
  assert.ok(post.indexOf("rejectCrossSite(request)") < post.indexOf("getCurrentUser()"));
  assert.ok(post.indexOf("parseTransferExecuteBody") < post.indexOf("createRotatingTokenProvider"));
  assert.doesNotMatch(src, /request\.json\(\)/);
});

test("no route handler still casts request.json() (all bodies go through readJsonBody), except the HMAC webhook", () => {
  const offenders: string[] = [];
  for (const file of routeFiles(path.join(ROOT, "app/api"))) {
    const rel = path.relative(ROOT, file);
    if (rel === "app/api/season-pass/callback/route.ts") continue;
    if (/request\.json\(\)/.test(readFileSync(file, "utf8"))) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

test("#80 auth invariants intact: session-cookie only, no oai-* header auth in app code, worker strips oai-*", () => {
  const worker = readFileSync(path.join(ROOT, "worker/index.ts"), "utf8");
  assert.match(worker, /startsWith\("oai-"\)/);
  assert.match(worker, /clean\.delete\(key\)/);
  const auth = readFileSync(path.join(ROOT, "app/lib/auth.ts"), "utf8");
  assert.doesNotMatch(auth.replace(/^\s*\/\/.*$/gm, ""), /oai-/);
});
