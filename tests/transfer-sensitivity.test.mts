import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeDecisionConfidence,
  freezeDecisionPlan,
  prepareDecisionScenarioContext,
} from "../app/lib/decision-confidence.ts";
import type { FplPlayer } from "../app/lib/fpl.ts";
import type { AvailablePlayerEventOutcomeModel, PlayerEventSensitivityMetadata } from "../app/lib/projection-distribution.ts";
import {
  TRANSFER_SENSITIVITY_LIMITS,
  analyzeTransferBreakEvenSensitivity,
  applyPlayerEventSensitivity,
} from "../app/lib/transfer-sensitivity.ts";

function player(id: number, positionShort: FplPlayer["positionShort"]): FplPlayer {
  return { id, name: `P${id}`, teamId: id, positionShort, positionId: positionShort === "GKP" ? 1 : positionShort === "DEF" ? 2 : positionShort === "MID" ? 3 : 4, eventPoints: 0, eventMinutes: 0 } as FplPlayer;
}

const audit = {
  targetExpectedPoints: 0, rawModeledMean: 0, reconciledModeledMean: 0, reconciliationGap: 0,
  tolerance: 1e-6, sampledMeanTolerance: .2,
  components: { appearancePoints: 0, goalPoints: 0, assistPoints: 0, cleanSheetPoints: 0, bonusPoints: 0,
    defensiveContributionPoints: 0, continuousSavePoints: 0, discreteSavePoints: 0, penaltySavePoints: 0 },
  assumptions: ["Synthetic sensitivity model."],
} as const;

function sensitivityMetadata(expectedMinutes = 60): PlayerEventSensitivityMetadata {
  return Object.freeze({
    expectedMinutes,
    attackingReturnRate: .5,
    fixtures: Object.freeze([Object.freeze({
      fixtureId: 101,
      conditionalExpectedGoals: .25,
      conditionalExpectedAssists: .25,
      confidence: 1,
      nonAttackingPointsWhenAppearedPmf: Object.freeze([1]),
      reconciliation: Object.freeze({ mode: "none" as const }),
    })]),
  });
}

function model(p: FplPlayer, pointsWhenAppearedPmf: number[], options: { appearance?: number; reached60?: number; cleanSheetProbability?: number; cleanSheetPoints?: number; expectedMinutes?: number } = {}): AvailablePlayerEventOutcomeModel {
  return {
    status: "available", player: p, eventId: 1,
    fixtures: [{ fixtureId: 101, teamId: p.teamId, appearanceProbability: options.appearance ?? 1,
      reached60Probability: options.reached60 ?? 1, pointsWhenAppearedPmf,
      cleanSheetProbability: options.cleanSheetProbability ?? 0, cleanSheetPoints: options.cleanSheetPoints ?? 0,
      reconciliation: "none" }],
    audit,
    sensitivity: sensitivityMetadata(options.expectedMinutes),
  };
}

function inputFor(incomingModel: AvailablePlayerEventOutcomeModel, hitCost = 0) {
  const outgoing = player(1, incomingModel.player.positionShort);
  const incoming = incomingModel.player;
  const baseline = freezeDecisionPlan({ id: "baseline", weeks: [{ eventId: 1, xi: [outgoing], bench: [], captain: outgoing, vice: outgoing, captainMultiplier: 2 }] });
  const candidate = freezeDecisionPlan({ id: "candidate", weeks: [{ eventId: 1, xi: [incoming], bench: [], captain: incoming, vice: incoming, captainMultiplier: 2 }] });
  return {
    incoming,
    analysis: {
      baseline, candidate, candidateAdditionalHitCost: hitCost, scenarioCount: 1024,
      playerEventModels: [model(outgoing, [1], { expectedMinutes: 60 }), incomingModel],
    },
  };
}

test("factor 1.0 sensitivity rescoring is exactly equivalent to canonical analysis", () => {
  const { incoming, analysis } = inputFor(model(player(2, "MID"), [.25, .25, .25, .25]));
  const prepared = prepareDecisionScenarioContext(analysis);
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") return;
  const rebuilt = analysis.playerEventModels.map(eventModel => eventModel.status === "available" && eventModel.player.id === incoming.id
    ? applyPlayerEventSensitivity(eventModel, { factor: "attacking-return-rate", scale: 1 })
    : eventModel);
  const result = analyzeTransferBreakEvenSensitivity({ context: prepared.context, incomingPlayerId: incoming.id, factorOneModels: rebuilt });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.deepEqual(result.factorOneResult, analyzeDecisionConfidence(analysis));
});

test("known appearance threshold is deterministic and reported in stored expected minutes", () => {
  const { incoming, analysis } = inputFor(model(player(2, "MID"), [0, 0, 0, 1], { expectedMinutes: 60 }), 5);
  const first = analyzeTransferBreakEvenSensitivity({ analysis, incomingPlayerId: incoming.id });
  const second = analyzeTransferBreakEvenSensitivity({ analysis, incomingPlayerId: incoming.id });
  assert.deepEqual(second, first);
  assert.equal(first.status, "available");
  if (first.status !== "available") return;
  const minutes = first.factors.find(factor => factor.factor === "expected-minutes");
  assert.equal(minutes?.status, "available");
  if (minutes?.status !== "available") return;
  assert.equal(minutes.direction, "below");
  assert.ok(minutes.threshold > 0 && minutes.threshold < 60);
  assert.equal(Number.isInteger(minutes.threshold), true, "minutes are reported without false decimal precision");
  assert.match(minutes.message, /modeled expected minutes fall below \d+ per fixture/);
});

test("a baseline-preferred decision searches increases, and a tie has no direction", () => {
  const losing = inputFor(model(player(2, "MID"), [1], { appearance: .2, reached60: .2, expectedMinutes: 18 }), 2);
  const increased = analyzeTransferBreakEvenSensitivity({ analysis: losing.analysis, incomingPlayerId: losing.incoming.id });
  assert.equal(increased.status, "available");
  if (increased.status === "available") assert.equal(increased.direction, "increase");

  const tied = inputFor(model(player(3, "MID"), [1], { expectedMinutes: 60 }));
  const tieResult = analyzeTransferBreakEvenSensitivity({ analysis: tied.analysis, incomingPlayerId: tied.incoming.id });
  assert.deepEqual(tieResult, { status: "unavailable", reason: "A tied decision has no break-even sensitivity direction." });
});

test("no reversal in the valid range is reported honestly", () => {
  const { incoming, analysis } = inputFor(model(player(2, "MID"), new Array(21).fill(0).map((_, index) => index === 20 ? 1 : 0)));
  const result = analyzeTransferBreakEvenSensitivity({ analysis, incomingPlayerId: incoming.id });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.ok(result.factors.some(factor => factor.status === "unavailable" && /does not reverse/.test(factor.reason)));
});

test("clean-sheet sensitivity is position-inapplicable for forwards", () => {
  const { incoming, analysis } = inputFor(model(player(2, "FWD"), [0, 0, 0, 1]));
  const result = analyzeTransferBreakEvenSensitivity({ analysis, incomingPlayerId: incoming.id });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  const cleanSheet = result.factors.find(factor => factor.factor === "clean-sheet-probability");
  assert.deepEqual(cleanSheet, { status: "unavailable", factor: "clean-sheet-probability", reason: "Clean-sheet points are not position-relevant for forwards." });
});

test("sensitivity transforms preserve PMFs, metadata and source models", () => {
  const source = model(player(2, "DEF"), [.5, 0, .5], { cleanSheetProbability: .4, cleanSheetPoints: 4 });
  const before = structuredClone(source);
  const adjusted = applyPlayerEventSensitivity(source, { factor: "clean-sheet-probability", scale: .5 });
  assert.deepEqual(source, before);
  assert.notEqual(adjusted, source);
  assert.equal(adjusted.status, "available");
  if (adjusted.status !== "available") return;
  assert.equal(adjusted.fixtures[0].cleanSheetProbability, .2);
  assert.deepEqual(adjusted.fixtures[0].pointsWhenAppearedPmf, source.fixtures[0].pointsWhenAppearedPmf);
  assert.ok(Math.abs(adjusted.fixtures[0].pointsWhenAppearedPmf.reduce((sum, p) => sum + p, 0) - 1) < 1e-12);
  assert.equal(Object.isFrozen(source.sensitivity), true);
  assert.doesNotThrow(() => structuredClone(source.sensitivity));
  assert.equal(TRANSFER_SENSITIVITY_LIMITS.scenarioCount, 1024);
  assert.equal(TRANSFER_SENSITIVITY_LIMITS.expectedMinutes.toleranceMinutes, 1);
  assert.equal(TRANSFER_SENSITIVITY_LIMITS.attackingReturnRate.toleranceScale, .01);
  assert.equal(TRANSFER_SENSITIVITY_LIMITS.cleanSheetProbability.toleranceProbability, .01);
});
