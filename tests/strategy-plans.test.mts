import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PLANS,
  createPlan,
  dehydratePlanSandbox,
  hydratePlanSandbox,
  readPlans,
  writePlans,
  PersistedPlan,
} from "../app/lib/strategy-plans.ts";
import type { FplPlayer } from "../app/lib/fpl.ts";

// Same in-memory localStorage stub as tests/persistence.test.mts, set up independently here so this
// file's storage-touching tests are deterministic whether run alone or as part of the full suite.
function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
}
(globalThis as any).localStorage = memoryStorage();

function makePlayer(id: number, name: string): FplPlayer {
  return {
    id, name, firstName: name, secondName: "", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: 3, position: "Midfielder", positionShort: "MID", price: 6, status: "a", chance: null,
    epNext: 0, form: 0, pointsPerGame: 0, priorPointsPerGame: 0, priorMinutes: 0, priorStarts: 0,
    priorExpectedGoals: 0, priorExpectedAssists: 0, priorBonus: 0, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 0, totalPoints: 0, eventPoints: 0, eventMinutes: 0, eventBonus: 0, eventDefensiveContribution: 0,
    selectedBy: 10, priceChange: 0, priceProjectionToday: 0, transfersIn: 0, transfersOut: 0, goals: 0, assists: 0,
    expectedGoals: 0, expectedAssists: 0, expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0,
    goalsConceded: 0, minutes: 0, starts: 0, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0,
    saves: 0, penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
  };
}

const p1 = makePlayer(1, "Alpha");
const p2 = makePlayer(2, "Bravo");
const p3 = makePlayer(3, "Charlie");
const pool = [p1, p2, p3];
const SETTINGS = { horizonMode: "Balanced 5 GWs", riskMode: "Balanced", philosophy: "Maximum xPts" } as const;

test("createPlan: baselineSquadIds capture real player ids, transferHistory starts empty, savedUnder captures the real settings", () => {
  const plan = createPlan("My Plan", [p1, p2], SETTINGS);
  assert.equal(plan.name, "My Plan");
  assert.deepEqual(plan.baselineSquadIds, [1, 2]);
  assert.deepEqual(plan.transferHistory, []);
  assert.deepEqual(plan.savedUnder, SETTINGS);
  assert.ok(plan.id.length > 0);
  assert.ok(!Number.isNaN(Date.parse(plan.createdAt)));
});

test("hydratePlanSandbox: a clean plan with no transfers hydrates to a complete sandbox with a matching baseline", () => {
  const plan = createPlan("Clean", [p1, p2], SETTINGS);
  const result = hydratePlanSandbox(plan, pool);
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.sandbox.baselineSquad.map(p => p.id), [1, 2]);
  assert.deepEqual(result.sandbox.currentSquad.map(p => p.id), [1, 2]);
  assert.deepEqual(result.sandbox.history, []);
});

test("hydratePlanSandbox: transfer history replays through the real applySandboxTransfer, not a re-derived mechanism", () => {
  const plan: PersistedPlan = {
    id: "x", name: "Swap", createdAt: new Date().toISOString(),
    baselineSquadIds: [1, 2],
    transferHistory: [{ outId: 1, incomingId: 3 }],
    savedUnder: SETTINGS,
  };
  const result = hydratePlanSandbox(plan, pool);
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.sandbox.currentSquad.map(p => p.id).sort(), [2, 3]);
  assert.equal(result.sandbox.history.length, 1);
  assert.equal(result.sandbox.history[0].out.id, 1);
  assert.equal(result.sandbox.history[0].incoming.id, 3);
});

test("hydratePlanSandbox: an unresolvable baseline player id fails the whole plan with a real, specific reason", () => {
  const plan: PersistedPlan = {
    id: "x", name: "Broken baseline", createdAt: new Date().toISOString(),
    baselineSquadIds: [1, 999],
    transferHistory: [],
    savedUnder: SETTINGS,
  };
  const result = hydratePlanSandbox(plan, pool);
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.match(result.reason, /baseline squad couldn't be restored/i);
});

test("hydratePlanSandbox: a transfer referencing a missing OUTGOING player id stops replay at that step, not before or after, and never crashes", () => {
  const plan: PersistedPlan = {
    id: "x", name: "Missing out", createdAt: new Date().toISOString(),
    baselineSquadIds: [1, 2],
    // Transfer 1 is legal (1 -> 3); transfer 2 references outId 999, which is not in the squad at
    // that point (it was never there) -- replay must stop exactly here, not silently skip it.
    transferHistory: [{ outId: 1, incomingId: 3 }, { outId: 999, incomingId: 2 }],
    savedUnder: SETTINGS,
  };
  const result = hydratePlanSandbox(plan, pool);
  assert.equal(result.status, "partial");
  if (result.status !== "partial") return;
  // Must reflect the state after the FIRST (legal) transfer, not the unmodified baseline and not a
  // crash -- proves replay genuinely stopped at step 2, not step 1.
  assert.deepEqual(result.sandbox.currentSquad.map(p => p.id).sort(), [2, 3]);
  assert.equal(result.sandbox.history.length, 1);
  assert.match(result.reason, /transfer 2 of 2/i);
});

test("hydratePlanSandbox: a transfer referencing a missing INCOMING player id also stops replay at that step (not just outgoing)", () => {
  const plan: PersistedPlan = {
    id: "x", name: "Missing incoming", createdAt: new Date().toISOString(),
    baselineSquadIds: [1, 2],
    transferHistory: [{ outId: 1, incomingId: 999 }],
    savedUnder: SETTINGS,
  };
  const result = hydratePlanSandbox(plan, pool);
  assert.equal(result.status, "partial");
  if (result.status !== "partial") return;
  assert.deepEqual(result.sandbox.currentSquad.map(p => p.id).sort(), [1, 2]);
  assert.equal(result.sandbox.history.length, 0);
  assert.match(result.reason, /transfer 1 of 1/i);
});

test("dehydratePlanSandbox: round-trips a hydrated sandbox back to an equivalent PersistedPlan", () => {
  const original: PersistedPlan = {
    id: "plan-1", name: "Round Trip", createdAt: "2026-01-01T00:00:00.000Z",
    baselineSquadIds: [1, 2],
    transferHistory: [{ outId: 1, incomingId: 3 }],
    savedUnder: SETTINGS,
  };
  const hydrated = hydratePlanSandbox(original, pool);
  assert.equal(hydrated.status, "complete");
  if (hydrated.status !== "complete") return;
  const dehydrated = dehydratePlanSandbox(original, hydrated.sandbox);
  assert.equal(dehydrated.id, original.id);
  assert.equal(dehydrated.name, original.name);
  assert.equal(dehydrated.createdAt, original.createdAt);
  assert.deepEqual(dehydrated.baselineSquadIds, original.baselineSquadIds);
  assert.deepEqual(dehydrated.transferHistory, original.transferHistory);
  assert.deepEqual(dehydrated.savedUnder, original.savedUnder);
});

test("readPlans: returns an empty array when nothing has ever been saved, not a crash", () => {
  (globalThis.localStorage as any).clear();
  assert.deepEqual(readPlans(), []);
});

test("readPlans: falls back to an empty array for malformed JSON or a non-array value, not a crash", () => {
  (globalThis.localStorage as any).clear();
  localStorage.setItem("fpl-edge-plans", "not valid json");
  assert.deepEqual(readPlans(), []);
  localStorage.setItem("fpl-edge-plans", JSON.stringify({ not: "an array" }));
  assert.deepEqual(readPlans(), []);
});

test("writePlans/readPlans: round-trips real plans through localStorage", () => {
  (globalThis.localStorage as any).clear();
  const plan = createPlan("Round Trip", [p1, p2], SETTINGS);
  writePlans([plan]);
  const read = readPlans();
  assert.equal(read.length, 1);
  assert.equal(read[0].id, plan.id);
  assert.equal(read[0].name, "Round Trip");
});

test("writePlans: clamps to MAX_PLANS even if called with more, matching the same cap enforced server-side", () => {
  (globalThis.localStorage as any).clear();
  const plans = Array.from({ length: MAX_PLANS + 3 }, (_, i) => createPlan(`Plan ${i}`, [p1], SETTINGS));
  writePlans(plans);
  assert.equal(readPlans().length, MAX_PLANS);
});
