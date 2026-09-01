import assert from "node:assert/strict";
import test from "node:test";
import { FplPlayer } from "../app/lib/fpl.ts";
import { MEANINGFUL_PRICE_PRESSURE, priceProtectionAlerts, priceTimingSignal } from "../app/components/CoachApp.tsx";

function makePlayer(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1, name: "Player", firstName: "Player", secondName: "One", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: 4, position: "Forward", positionShort: "FWD", price: 8, status: "a", chance: null,
    epNext: 5, form: 5, pointsPerGame: 5, priorPointsPerGame: 5, priorMinutes: 2000, priorStarts: 25,
    priorExpectedGoals: 10, priorExpectedAssists: 3, priorBonus: 15, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 0, totalPoints: 0, eventPoints: 0, eventMinutes: 0, eventBonus: 0, eventDefensiveContribution: 0, selectedBy: 20, priceChange: 0, priceProjectionToday: 0,
    transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0,
    expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 0,
    starts: 0, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0,
    penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
    ...overrides,
  };
}

// --- priceTimingSignal: honest framing over FPL's own first-party projection, not an invented heuristic ---

test("priceTimingSignal: strong rise pressure -- direction rise, message states the actual percent", () => {
  const player = makePlayer({ priceProjectionToday: 34.3 });
  const result = priceTimingSignal(player);
  assert.equal(result.direction, "rise");
  assert.ok(result.message.includes("34%"), `expected the message to state 34%, got: ${result.message}`);
});

test("priceTimingSignal: strong fall pressure -- direction fall, message states the absolute percent", () => {
  const player = makePlayer({ priceProjectionToday: -20.3 });
  const result = priceTimingSignal(player);
  assert.equal(result.direction, "fall");
  assert.ok(result.message.includes("20%"), `expected the message to state 20% (not -20%), got: ${result.message}`);
});

test("priceTimingSignal: modest pressure well below the threshold -- stable, no false urgency", () => {
  const player = makePlayer({ priceProjectionToday: 5 });
  const result = priceTimingSignal(player);
  assert.equal(result.direction, "stable");
});

test(`priceTimingSignal: exactly at the +${MEANINGFUL_PRICE_PRESSURE} boundary -- counts as rise`, () => {
  const player = makePlayer({ priceProjectionToday: MEANINGFUL_PRICE_PRESSURE });
  const result = priceTimingSignal(player);
  assert.equal(result.direction, "rise");
});

test(`priceTimingSignal: just below the +${MEANINGFUL_PRICE_PRESSURE} boundary -- still stable`, () => {
  const player = makePlayer({ priceProjectionToday: MEANINGFUL_PRICE_PRESSURE - 0.1 });
  const result = priceTimingSignal(player);
  assert.equal(result.direction, "stable");
});

test(`priceTimingSignal: exactly at the -${MEANINGFUL_PRICE_PRESSURE} boundary -- counts as fall`, () => {
  const player = makePlayer({ priceProjectionToday: -MEANINGFUL_PRICE_PRESSURE });
  const result = priceTimingSignal(player);
  assert.equal(result.direction, "fall");
});

// --- priceProtectionAlerts: only squad players at real risk of a drop, worst-first ---

test("priceProtectionAlerts: no squad player clears the threshold -- empty", () => {
  const squad = [makePlayer({ id: 1, priceProjectionToday: 5 }), makePlayer({ id: 2, priceProjectionToday: -10 })];
  assert.deepEqual(priceProtectionAlerts(squad), []);
});

test("priceProtectionAlerts: a squad player with real fall pressure is flagged", () => {
  const squad = [makePlayer({ id: 1, name: "AtRisk", priceProjectionToday: -25 })];
  const result = priceProtectionAlerts(squad);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "AtRisk");
});

test("priceProtectionAlerts: a squad player with strong RISE pressure is never flagged -- only falls are a risk to protect against", () => {
  const squad = [makePlayer({ id: 1, name: "Rising", priceProjectionToday: 40 })];
  assert.deepEqual(priceProtectionAlerts(squad), []);
});

test("priceProtectionAlerts: multiple at-risk players are sorted worst (most negative) first", () => {
  const squad = [
    makePlayer({ id: 1, name: "Mild", priceProjectionToday: -16 }),
    makePlayer({ id: 2, name: "Severe", priceProjectionToday: -40 }),
    makePlayer({ id: 3, name: "Safe", priceProjectionToday: 2 }),
  ];
  const result = priceProtectionAlerts(squad);
  assert.deepEqual(result.map(p => p.name), ["Severe", "Mild"]);
});
