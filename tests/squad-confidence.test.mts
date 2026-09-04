import assert from "node:assert/strict";
import test from "node:test";
import { FplPlayer } from "../app/lib/fpl.ts";
import { SquadEvaluation, WeekPlan } from "../app/lib/optimizer.ts";
import {
  PlayerEventModelCache,
  analyzeSquadDecisionConfidence,
  prepareSquadDecisionConfidence,
} from "../app/lib/squad-confidence.ts";

type Position = FplPlayer["positionShort"];

function player(id: number, positionShort: Position): FplPlayer {
  return {
    id, name: `P${id}`, firstName: `P${id}`, secondName: "", teamId: id, teamName: `T${id}`, teamShort: `T${id}`,
    positionId: positionShort === "GKP" ? 1 : positionShort === "DEF" ? 2 : positionShort === "MID" ? 3 : 4,
    position: positionShort, positionShort, price: 5, status: "a", chance: null, epNext: 0, form: 0,
    pointsPerGame: 0, priorPointsPerGame: 0, priorMinutes: 0, priorStarts: 0, priorExpectedGoals: 0,
    priorExpectedAssists: 0, priorBonus: 0, priorSaves: 0, priorPenaltiesSaved: 0, priorDefensiveContribution: 0,
    totalPoints: 0, eventPoints: 0, eventMinutes: 0, eventBonus: 0, eventDefensiveContribution: 0, selectedBy: 0, priceChange: 0, priceProjectionToday: 0, priceChangeSinceStart: 0, priceOutlook: [],
    transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0,
    expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 0,
    starts: 0, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0,
    penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
  };
}

function squad(offset = 0): FplPlayer[] {
  return [
    player(1 + offset, "GKP"), player(2 + offset, "GKP"),
    ...Array.from({ length: 5 }, (_, i) => player(10 + i + offset, "DEF")),
    ...Array.from({ length: 5 }, (_, i) => player(20 + i + offset, "MID")),
    ...Array.from({ length: 3 }, (_, i) => player(30 + i + offset, "FWD")),
  ];
}

function evaluation(players: FplPlayer[], eventIds = [1]): SquadEvaluation {
  const weeks: WeekPlan[] = eventIds.map(eventId => ({
    eventId, xi: players.slice(0, 11), bench: players.slice(11), captain: players[0], vice: players[1],
    formation: "3-5-2", points: 0, captainPoints: 0,
  }));
  return {
    objective: 0, weightedPoints: 0, fiveWeekPoints: 0, weeks, flexibility: 0, benchUtility: 0, deadSlots: 0,
    riskPenalty: 0, bank: 0,
    scores: { projectedPoints: 0, captaincy: 0, fixtures: 0, minutesSecurity: 0, bench: 0, flexibility: 0, value: 0, risk: 0, overall: 20 },
    warnings: [], strategy: { formation: "3-5-2", premiums: [], captain: players[0].name, budget: {}, benchSpend: 0, targets: [], risk: "Balanced" },
  };
}

test("generic squad adapter applies the candidate hit once while reusing frozen optimizer plans", () => {
  const baselineSquad = squad();
  const candidateSquad = squad(100);
  const result = analyzeSquadDecisionConfidence({
    fixtures: [], futureEventIds: [1], dataUpdatedAt: "2099-01-01T00:00:00Z",
    baselineSquad, candidateSquad,
    baselineEvaluation: evaluation(baselineSquad), candidateEvaluation: evaluation(candidateSquad),
    candidateAdditionalHitCost: 4, scenarioCount: 64,
  });

  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.expectedDelta, -4);
  assert.equal(result.preferred, "baseline");
  assert.deepEqual(result.frequencies, {
    gain: { count: 0, rate: 0 }, tie: { count: 0, rate: 0 }, loss: { count: 64, rate: 1 },
  });
});

test("generic squad adapter rejects incomplete squads and mismatched optimizer horizons honestly", () => {
  const baselineSquad = squad();
  const candidateSquad = squad(100);
  const incomplete = analyzeSquadDecisionConfidence({
    fixtures: [], futureEventIds: [1], dataUpdatedAt: "stamp", baselineSquad: baselineSquad.slice(1), candidateSquad,
    baselineEvaluation: evaluation(baselineSquad.slice(1)), candidateEvaluation: evaluation(candidateSquad), candidateAdditionalHitCost: 0,
  });
  assert.deepEqual(incomplete, { status: "unavailable", reason: "Decision Confidence requires two complete 15-player squads." });

  const mismatched = analyzeSquadDecisionConfidence({
    fixtures: [], futureEventIds: [1], dataUpdatedAt: "stamp", baselineSquad, candidateSquad,
    baselineEvaluation: evaluation(baselineSquad, [2]), candidateEvaluation: evaluation(candidateSquad), candidateAdditionalHitCost: 0,
  });
  assert.deepEqual(mismatched, { status: "unavailable", reason: "Baseline and candidate evaluations do not cover the explicit future event horizon." });
});

test("MAX_DECISION_HORIZON accepts exactly 8 future events (matching the app's own Long-term 8 GWs ceiling) and rejects 9", () => {
  const baselineSquad = squad();
  const candidateSquad = squad(100);
  const eightEvents = Array.from({ length: 8 }, (_, i) => i + 1);
  const nineEvents = Array.from({ length: 9 }, (_, i) => i + 1);

  const atCeiling = analyzeSquadDecisionConfidence({
    fixtures: [], futureEventIds: eightEvents, dataUpdatedAt: "stamp", baselineSquad, candidateSquad,
    baselineEvaluation: evaluation(baselineSquad, eightEvents), candidateEvaluation: evaluation(candidateSquad, eightEvents),
    candidateAdditionalHitCost: 0, scenarioCount: 8,
  });
  assert.equal(atCeiling.status, "available");
  if (atCeiling.status === "available") {
    assert.equal(atCeiling.availableGameweeks, 8);
    assert.equal(atCeiling.horizonTier, "extended");
  }

  const overCeiling = analyzeSquadDecisionConfidence({
    fixtures: [], futureEventIds: nineEvents, dataUpdatedAt: "stamp", baselineSquad, candidateSquad,
    baselineEvaluation: evaluation(baselineSquad, nineEvents), candidateEvaluation: evaluation(candidateSquad, nineEvents),
    candidateAdditionalHitCost: 0,
  });
  assert.deepEqual(overCeiling, { status: "unavailable", reason: "Decision Confidence supports at most 8 future events." });
});

test("player/event preparation cache is bounded, stable by data update/event/player, and deterministic when warm", () => {
  const baselineSquad = squad();
  const candidateSquad = [...baselineSquad.slice(0, 14), player(999, "FWD")];
  const cache = new PlayerEventModelCache(20);
  const input = {
    fixtures: [], futureEventIds: [1], dataUpdatedAt: "2099-01-01T00:00:00Z", baselineSquad, candidateSquad,
    baselineEvaluation: evaluation(baselineSquad), candidateEvaluation: evaluation(candidateSquad), candidateAdditionalHitCost: 0,
    scenarioCount: 64,
  };
  const cold = prepareSquadDecisionConfidence(input, cache);
  const coldSize = cache.size;
  const warm = prepareSquadDecisionConfidence(input, cache);

  assert.equal(cold.status, "prepared");
  assert.equal(warm.status, "prepared");
  assert.equal(cache.size, coldSize);
  assert.ok(cache.size <= 20);
  assert.equal(JSON.stringify(cold), JSON.stringify(warm));
});

