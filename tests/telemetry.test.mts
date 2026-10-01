import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { allowTelemetry, hashUserId, sanitizeTelemetry, telemetryRow, type RateWindow } from "../app/lib/telemetry.ts";

const route = readFileSync(new URL("../app/api/telemetry/route.ts", import.meta.url), "utf8");

test("unauthenticated landing_view produces an insertable row with null user_hash", () => {
  const ev = sanitizeTelemetry({ event: "landing_view", path: "/?demo=1#x" });
  assert.ok(ev);
  const row = telemetryRow({ ...ev, userHash: null, id: "1", ts: "2026-10-01T00:00:00Z" });
  assert.equal(row.event, "landing_view");
  assert.equal(row.userHash, null);
  assert.equal(row.path, "/");
  assert.equal(row.meta, "{}");
});

test("rate limit returns false after the cap and never throws; route answers 429 not 500", () => {
  const store = new Map<string, RateWindow>();
  let allowed = 0;
  for (let i = 0; i < 100; i++) if (allowTelemetry(store, "ip", 1000, { max: 60, windowMs: 60_000 })) allowed++;
  assert.equal(allowed, 60);
  assert.equal(allowTelemetry(store, "ip", 1000 + 60_000), true);
  assert.match(route, /done\(429\)/);
  assert.ok(!/status:\s*500/.test(route));
  assert.match(route, /rejectCrossSite/);
});

test("email / squad / names / team id are stripped", () => {
  const ev = sanitizeTelemetry({ event: "signin_success", meta: { email: "a@b.co", mode: "signin", ref: "x@y.com", squad: [1, 2], playerName: "Salah", teamId: 123, entry: 99 } });
  assert.deepEqual(ev?.meta, { mode: "signin" });
  assert.ok(!JSON.stringify(ev).includes("@"));
  assert.equal(sanitizeTelemetry({ event: "steal_cookies" }), null);
});

test("demo lock never looks like a real lock_created", () => {
  assert.equal(sanitizeTelemetry({ event: "lock_created", meta: { source: "demo", gw: 6 } })?.meta.source, "demo");
  assert.equal(sanitizeTelemetry({ event: "lock_created", meta: { gw: 6 } })?.meta.source, "unknown");
  assert.equal(sanitizeTelemetry({ event: "lock_created", meta: { source: "fake" } })?.meta.source, "unknown");
  const panel = readFileSync(new URL("../app/components/coach/FinalCheckPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /track\("lock_created",\{[^}]*source:isExampleSquadActive\(\)\?"demo":"real"/);
});

test("call_viewed action is HOLD|MAKE only; user hash is one-way", async () => {
  assert.equal(sanitizeTelemetry({ event: "call_viewed", meta: { action: "MAKE", source: "real" } })?.meta.action, "MAKE");
  assert.equal(sanitizeTelemetry({ event: "call_viewed", meta: { action: "Raya" } })?.meta.action, undefined);
  const h = await hashUserId("user-1");
  assert.match(h, /^[0-9a-f]{32}$/);
  assert.ok(!h.includes("user-1"));
});
