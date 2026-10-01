import assert from "node:assert/strict";
import test from "node:test";
import { classifyUrgency, riskLabel, START_RISK_THRESHOLD } from "../app/lib/urgency.ts";
import type { FplPlayer } from "../app/lib/fpl.ts";

const pl = (id: number, status = "a") => ({ id, name: `P${id}`, status } as unknown as FplPlayer);
const xi = Array.from({ length: 11 }, (_, i) => pl(i + 1));
const bench = [pl(12), pl(13), pl(14), pl(15)];
const pct = (m: Record<number, number>) => (p: FplPlayer) => m[p.id] ?? 90;

test("bench slot 3 at 16% with no flag is MONITOR, never URGENT", () => {
  const r = classifyUrgency({ xi, bench, startPct: pct({ 14: 16 }) });
  assert.equal(r.urgent.length, 0);
  assert.ok(r.monitor.some(m => m.player.id === 14));
});
test("XI player at 16% → URGENT; XI yellow flag → URGENT", () => {
  assert.ok(classifyUrgency({ xi, bench, startPct: pct({ 3: 16 }) }).urgent.some(u => u.player.id === 3));
  const flagged = xi.map(p => p.id === 4 ? pl(4, "d") : p);
  assert.ok(classifyUrgency({ xi: flagged, bench, startPct: pct({}) }).urgent.some(u => u.player.id === 4));
});
test("first sub <50% is URGENT only when an XI player is at risk", () => {
  assert.equal(classifyUrgency({ xi, bench, startPct: pct({ 12: 30 }) }).urgent.length, 0);
  assert.ok(classifyUrgency({ xi, bench, startPct: pct({ 12: 30, 2: 20 }) }).urgent.some(u => u.player.id === 12));
});
test("flagged recommended target is URGENT", () => {
  assert.ok(classifyUrgency({ xi, bench, startPct: pct({}), target: pl(99, "d") }).urgent.some(u => u.player.id === 99));
});
test("no player is LIKELY on the pitch and URGENT on Home in one render", () => {
  for (const s of [0, 16, 41, 49, 50, 68, 90]) for (const status of ["a", "d", "i"]) {
    const p = pl(5, status);
    const r = classifyUrgency({ xi: [p], bench: [], startPct: () => s });
    const isUrgent = r.urgent.some(u => u.player.id === 5);
    assert.equal(isUrgent, riskLabel(p, s) !== "LIKELY", `start ${s} status ${status}`);
  }
  assert.equal(START_RISK_THRESHOLD, 50);
});
