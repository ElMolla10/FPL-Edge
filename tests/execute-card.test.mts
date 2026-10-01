import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildExecuteSummary } from "../app/lib/execute-summary.ts";
import { formatNet, formatHit, WEEKLY_DECISION_SOURCE, type WeeklyDecision } from "../app/lib/weekly-decision.ts";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
const { activeLocksKey, EXAMPLE_LOCKS_KEY, REAL_LOCKS_KEY, EXAMPLE_SQUAD_FLAG_KEY, clearExampleSquadFlag } = await import("../app/lib/example-squad.ts");

const p = (id: number, name: string) => ({ id, name });
const xi = Array.from({ length: 11 }, (_, i) => p(i + 1, `P${i + 1}`));
const bench = [p(12, "B1"), p(13, "B2"), p(14, "B3"), p(15, "B4")];
const base = { gameweek: 7, classification: "MAKE", captainId: 1, net3gw: 4.04, riskAdjustedNet5gw: 8.04, immediateNet: 2.1, confidence: 0.8, risk: "Low", why: "x", source: WEEKLY_DECISION_SOURCE, freeTransfers: 1, freeTransferSource: "assumed", wildcardActive: false } as const;
const make = { ...base, action: "MAKE", outPlayerId: 3, inPlayerId: 99, outName: "Raya", inName: "Kelleher", hitCost: 0, net5gw: 8.05, bank: 1.5, row: { bankAfter: 2.0 } } as unknown as WeeklyDecision;
const hold = { ...base, action: "HOLD", classification: "HOLD", outPlayerId: null, inPlayerId: null, outName: null, inName: null, hitCost: 0, net5gw: 0, bank: 1.5, row: null } as unknown as WeeklyDecision;
const sum = (d: WeeklyDecision) => buildExecuteSummary({ decision: d, formation: "3-4-3", xi, bench, captain: xi[0], vice: xi[1], chip: null });

test("Execute card numbers === Transfers BEST DECISION (same object, same formatNet/formatHit)", () => {
  const s = sum(make);
  assert.equal(s.move.action, "MAKE");
  if (s.move.action !== "MAKE") return;
  assert.equal(s.move.out, make.outName);
  assert.equal(s.move.in, make.inName);
  assert.equal(s.move.net5gw, formatNet(make.net5gw));
  assert.equal(s.move.hit, formatHit(make));
  assert.equal(s.bankAfter, 2.0);
  const transfers = readFileSync("app/components/coach/TransfersPanel.tsx", "utf8");
  assert.match(transfers, /formatNet\(/);
  const final = readFileSync("app/components/coach/FinalCheckPanel.tsx", "utf8");
  assert.match(final, /useWeeklyDecision\(data,squad,meta\)/);
});
test("HOLD shows no move, bank unchanged, checklist + share text name players", () => {
  const s = sum(hold);
  assert.equal(s.move.action, "HOLD");
  assert.equal(s.bankAfter, 1.5);
  assert.ok(s.checklist.some(l => l.includes("P1") && l.includes("Captain")));
  assert.match(s.shareText, /GW7/);
  assert.match(s.shareText, /P1 \(C\)/);
});
test("lock still writes the existing LockRecord receipt schema", () => {
  const final = readFileSync("app/components/coach/FinalCheckPanel.tsx", "utf8");
  assert.match(final, /const record:LockRecord=\{event:a\.first,lockedAt:capturedAt,dataUpdatedAt:data\.updatedAt,predicted:receipt\.squad\.predictedTotal,squadIds:/);
  assert.match(final, /persist\(REAL_LOCKS_KEY,next\)/);
  assert.equal(REAL_LOCKS_KEY, "fpl-edge-locks");
});
test("demo lock stays on the example storage key", () => {
  store.clear();
  assert.equal(activeLocksKey(), REAL_LOCKS_KEY);
  store.set(EXAMPLE_SQUAD_FLAG_KEY, "1");
  assert.equal(activeLocksKey(), EXAMPLE_LOCKS_KEY);
  const final = readFileSync("app/components/coach/FinalCheckPanel.tsx", "utf8");
  assert.match(final, /if\(isExampleSquadActive\(\)\)localStorage\.setItem\(EXAMPLE_LOCKS_KEY,next\)/);
  store.set(EXAMPLE_LOCKS_KEY, "[]");
  clearExampleSquadFlag();
  assert.equal(store.has(EXAMPLE_LOCKS_KEY), false);
});
test("read-only: Execute card never imports the personal transfer module", () => {
  const card = readFileSync("app/components/coach/ExecuteCard.tsx", "utf8") + readFileSync("app/lib/execute-summary.ts", "utf8");
  assert.ok(!card.includes("personal-fpl-transfer"));
});
