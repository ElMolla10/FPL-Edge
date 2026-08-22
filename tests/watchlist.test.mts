import assert from "node:assert/strict";
import test from "node:test";
import { FplPlayer, ProjectionMetrics } from "../app/lib/fpl.ts";
import { buyTriggerMessage } from "../app/components/CoachApp.tsx";

function makePlayer(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1, name: "Target", firstName: "Target", secondName: "Player", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: 3, position: "Midfielder", positionShort: "MID", price: 6, status: "a", chance: null,
    epNext: 2, form: 2, pointsPerGame: 3, priorPointsPerGame: 3, priorMinutes: 1500, priorStarts: 20,
    priorExpectedGoals: 3, priorExpectedAssists: 3, priorBonus: 10, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 100, totalPoints: 0, eventPoints: 0, selectedBy: 10, priceChange: 0,
    transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0,
    expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 0,
    starts: 0, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0,
    penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<ProjectionMetrics> = {}): ProjectionMetrics {
  return {
    xPts: 5, expectedMinutes: 80, startProbability: 0.9, sixtyProbability: 0.85, rotationRisk: 0.1,
    xG: 0.3, xA: 0.2, xG90: 0.15, xA90: 0.1, cleanSheetProbability: 0.3, bonus: 0.5, defensiveContribution: 0.2, saves: 0,
    penaltyRole: false, setPieceRole: false, confidence: 0.8,
    ...overrides,
  };
}

test("buyTriggerMessage: no natural replacement in squad", () => {
  const target = makePlayer({ price: 6 });
  const result = buyTriggerMessage(target, undefined, makeMetrics(), 20, 0, 5);
  assert.equal(result.ready, false);
  assert.match(result.message, /build your squad first/);
});

test("buyTriggerMessage: unaffordable given current bank -- reports the exact shortfall", () => {
  const target = makePlayer({ price: 8 });
  const natural = makePlayer({ id: 2, price: 5 });
  // priceDiff = 3, bank = 1 -> shortfall = 2
  const result = buyTriggerMessage(target, natural, makeMetrics(), 20, 15, 1);
  assert.equal(result.ready, false);
  assert.match(result.message, /If price drops by £2\.0m/);
  assert.match(result.message, /£6\.0m or below/);
});

test("buyTriggerMessage: affordable but start probability below 70% -- reports the actual percentage", () => {
  const target = makePlayer({ price: 6 });
  const natural = makePlayer({ id: 2, price: 6 });
  const result = buyTriggerMessage(target, natural, makeMetrics({ startProbability: 0.55 }), 25, 10, 5);
  assert.equal(result.ready, false);
  assert.match(result.message, /clears 70%/);
  assert.match(result.message, /currently 55%/);
});

test("buyTriggerMessage: affordable, secure minutes, but gain over natural replacement is still small", () => {
  const target = makePlayer({ price: 6 });
  const natural = makePlayer({ id: 2, name: "Incumbent", price: 6 });
  // gain5 = 12 - 11 = 1, below the 2pt threshold
  const result = buyTriggerMessage(target, natural, makeMetrics({ startProbability: 0.9 }), 12, 11, 5);
  assert.equal(result.ready, false);
  assert.match(result.message, /Needs a bigger fixture-adjusted edge/);
  assert.match(result.message, /Incumbent/);
});

test("buyTriggerMessage: affordable, secure, and a real gain -- ready to buy", () => {
  const target = makePlayer({ price: 6 });
  const natural = makePlayer({ id: 2, name: "Incumbent", price: 6 });
  // gain5 = 20 - 10 = 10
  const result = buyTriggerMessage(target, natural, makeMetrics({ startProbability: 0.9 }), 20, 10, 5);
  assert.equal(result.ready, true);
  assert.match(result.message, /Clears your transfer threshold now: \+10\.0 pts/);
  assert.match(result.message, /Incumbent/);
});

test("buyTriggerMessage: a cheaper target (negative price diff) is never blocked on affordability", () => {
  const target = makePlayer({ price: 4 });
  const natural = makePlayer({ id: 2, price: 7 });
  const result = buyTriggerMessage(target, natural, makeMetrics({ startProbability: 0.9 }), 20, 5, 0);
  // priceDiff = -3, well within any bank (even £0) -- must not report an affordability blocker
  assert.doesNotMatch(result.message, /price drops/);
});

// The badge (BUY/CLOSE/WATCH) is derived directly from ready/close, so these fix the same
// reconciliation the badge depends on -- a badge/message disagreement would show up here first.
test("buyTriggerMessage: close=true when the only blocker is a small price shortfall (<=1.0m)", () => {
  const target = makePlayer({ price: 6 });
  const natural = makePlayer({ id: 2, price: 5.5 });
  // priceDiff = 0.5, bank = 0 -> shortfall = 0.5, well under the 1.0m "close" cutoff
  const result = buyTriggerMessage(target, natural, makeMetrics(), 20, 10, 0);
  assert.equal(result.ready, false);
  assert.equal(result.close, true);
});

test("buyTriggerMessage: close=false when the price shortfall is large (>1.0m)", () => {
  const target = makePlayer({ price: 9 });
  const natural = makePlayer({ id: 2, price: 5 });
  // priceDiff = 4, bank = 0 -> shortfall = 4, well over the 1.0m "close" cutoff
  const result = buyTriggerMessage(target, natural, makeMetrics(), 20, 10, 0);
  assert.equal(result.ready, false);
  assert.equal(result.close, false);
});

test("buyTriggerMessage: close=true when start probability is just below the 70% bar (>=55%)", () => {
  const target = makePlayer({ price: 6 });
  const natural = makePlayer({ id: 2, price: 6 });
  const result = buyTriggerMessage(target, natural, makeMetrics({ startProbability: 0.6 }), 25, 10, 5);
  assert.equal(result.ready, false);
  assert.equal(result.close, true);
});

test("buyTriggerMessage: close=false when start probability is far below the 70% bar (<55%)", () => {
  const target = makePlayer({ price: 6 });
  const natural = makePlayer({ id: 2, price: 6 });
  const result = buyTriggerMessage(target, natural, makeMetrics({ startProbability: 0.3 }), 25, 10, 5);
  assert.equal(result.ready, false);
  assert.equal(result.close, false);
});

test("buyTriggerMessage: close=true when the 5-GW gain is just below the 2pt bar (>=1pt)", () => {
  const target = makePlayer({ price: 6 });
  const natural = makePlayer({ id: 2, name: "Incumbent", price: 6 });
  // gain5 = 12 - 11 = 1
  const result = buyTriggerMessage(target, natural, makeMetrics({ startProbability: 0.9 }), 12, 11, 5);
  assert.equal(result.ready, false);
  assert.equal(result.close, true);
});

test("buyTriggerMessage: close=false when the 5-GW gain is far below the 2pt bar (<1pt)", () => {
  const target = makePlayer({ price: 6 });
  const natural = makePlayer({ id: 2, name: "Incumbent", price: 6 });
  // gain5 = 12 - 11.5 = 0.5
  const result = buyTriggerMessage(target, natural, makeMetrics({ startProbability: 0.9 }), 12, 11.5, 5);
  assert.equal(result.ready, false);
  assert.equal(result.close, false);
});

test("buyTriggerMessage: no natural replacement is never reported as close", () => {
  const target = makePlayer({ price: 6 });
  const result = buyTriggerMessage(target, undefined, makeMetrics(), 20, 0, 5);
  assert.equal(result.close, false);
});
