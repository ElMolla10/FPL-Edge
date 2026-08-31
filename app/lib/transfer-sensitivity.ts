import type {
  DecisionConfidenceAvailable,
  DecisionConfidenceInput,
  DecisionConfidenceResult,
  PreparedDecisionScenarioContext,
} from "./decision-confidence";
import {
  analyzePreparedDecisionContext,
  analyzePreparedDecisionDeltas,
  playerEventOutcomeKey,
  prepareDecisionScenarioContext,
  sampleDecisionScenario,
  scoreDecisionPlanWeek,
} from "./decision-confidence";
import type { AvailablePlayerEventOutcomeModel, PlayerEventOutcomeModel, Pmf } from "./projection-distribution";
import { assistsPointsPmf, convolvePmfs, goalsPointsPmf } from "./projection-distribution";

export const TRANSFER_SENSITIVITY_LIMITS = Object.freeze({
  scenarioCount: 1024,
  expectedMinutes: Object.freeze({ min: 0, max: 90, toleranceMinutes: 1, reportingStep: 1 }),
  attackingReturnRate: Object.freeze({ minScale: 0, maxScale: 2, toleranceScale: .01, reportingStepPercent: 1 }),
  cleanSheetProbability: Object.freeze({ minScale: 0, maxScale: 10, toleranceProbability: .01, reportingStepPercentagePoints: 1 }),
  maxBinaryIterations: 10,
});

export type TransferSensitivityFactor = "expected-minutes" | "attacking-return-rate" | "clean-sheet-probability";
export type PlayerEventSensitivityChange = Readonly<{
  factor: TransferSensitivityFactor;
  scale: number;
}>;

export type TransferSensitivityFactorResult =
  | { status: "available"; factor: TransferSensitivityFactor; direction: "below" | "above"; threshold: number; message: string }
  | { status: "unavailable"; factor: TransferSensitivityFactor; reason: string };

export type TransferBreakEvenSensitivityResult =
  | {
      status: "available";
      direction: "reduction" | "increase";
      factorOneResult: DecisionConfidenceAvailable;
      factors: readonly TransferSensitivityFactorResult[];
      assumptions: readonly string[];
    }
  | { status: "unavailable"; reason: string };

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

function thinPmf(pmf: readonly number[], keepProbability: number): Pmf {
  const keep = clamp(keepProbability), result = pmf.map(probability => probability * keep);
  result[0] = (result[0] ?? 0) + 1 - keep;
  return result;
}

/** Returns a fresh model for changed factors and the exact source object at scale 1.0. */
export function applyPlayerEventSensitivity(
  model: AvailablePlayerEventOutcomeModel,
  change: PlayerEventSensitivityChange,
): AvailablePlayerEventOutcomeModel {
  if (change.scale === 1) return model;
  if (!Number.isFinite(change.scale) || change.scale < 0) throw new Error("Sensitivity scale must be a finite non-negative number.");
  const metadata = model.sensitivity;
  if (!metadata) throw new Error(`Player ${model.player.id} event ${model.eventId} has no sensitivity metadata.`);
  const sources = new Map(metadata.fixtures.map(source => [source.fixtureId, source]));
  const fixtures = model.fixtures.map(fixture => {
    if (change.factor === "expected-minutes") {
      const appearanceProbability = clamp(fixture.appearanceProbability * change.scale);
      return {
        ...fixture,
        appearanceProbability,
        reached60Probability: clamp(fixture.reached60Probability * change.scale, 0, appearanceProbability),
        pointsWhenAppearedPmf: [...fixture.pointsWhenAppearedPmf],
      };
    }
    if (change.factor === "clean-sheet-probability") {
      return {
        ...fixture,
        cleanSheetProbability: clamp(fixture.cleanSheetProbability * change.scale),
        pointsWhenAppearedPmf: [...fixture.pointsWhenAppearedPmf],
      };
    }
    const source = sources.get(fixture.fixtureId);
    if (!source) throw new Error(`Player ${model.player.id} event ${model.eventId} fixture ${fixture.fixtureId} has no attacking sensitivity source.`);
    let pointsWhenAppearedPmf = convolvePmfs([
      goalsPointsPmf(source.conditionalExpectedGoals * change.scale, source.confidence, model.player.positionShort),
      assistsPointsPmf(source.conditionalExpectedAssists * change.scale, source.confidence),
      [...source.nonAttackingPointsWhenAppearedPmf],
    ]);
    if (source.reconciliation.mode === "thinned") pointsWhenAppearedPmf = thinPmf(pointsWhenAppearedPmf, source.reconciliation.keepProbability);
    if (source.reconciliation.mode === "added") pointsWhenAppearedPmf = convolvePmfs([pointsWhenAppearedPmf, [...source.reconciliation.additionPmf]]);
    return { ...fixture, pointsWhenAppearedPmf };
  });
  return { ...model, fixtures };
}

type SensitivityInput = {
  analysis?: DecisionConfidenceInput;
  context?: PreparedDecisionScenarioContext;
  incomingPlayerId: number;
  factorOneModels?: readonly PlayerEventOutcomeModel[];
};

type PreparedIncomingScoreResponse = Readonly<{
  eventId: number;
  absent: Float64Array;
  appearedAtZero: Float64Array;
  pointMultiplier: Float64Array;
}>;

type PreparedTransferSensitivityContext = Readonly<{
  decision: PreparedDecisionScenarioContext;
  incomingPlayerId: number;
  scores: readonly PreparedIncomingScoreResponse[];
}>;

const available = (result: DecisionConfidenceResult): result is DecisionConfidenceAvailable => result.status === "available";
const reversed = (result: DecisionConfidenceAvailable, direction: "reduction" | "increase") =>
  direction === "reduction" ? result.expectedDelta < 0 : result.expectedDelta > 0;

function average(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function prepareIncomingScoreResponses(
  context: PreparedDecisionScenarioContext,
  incomingPlayerId: number,
): PreparedTransferSensitivityContext | { status: "unavailable"; reason: string } {
  const scores: PreparedIncomingScoreResponse[] = [];
  for (const week of context.input.candidate.weeks) {
    const occurrences = [...week.xi, ...week.bench].filter(player => player.id === incomingPlayerId).length;
    if (occurrences !== 1) return { status: "unavailable", reason: `Incoming player ${incomingPlayerId} must appear exactly once in every frozen candidate week.` };
    const key = playerEventOutcomeKey(week.eventId, incomingPlayerId);
    const absent = new Float64Array(context.scenarioCount);
    const appearedAtZero = new Float64Array(context.scenarioCount);
    const pointMultiplier = new Float64Array(context.scenarioCount);
    for (let scenario = 0; scenario < context.scenarioCount; scenario++) {
      const canonical = context.scenarioOutcomes[scenario];
      let replacement = { appeared: false, reached60: false, points: 0 };
      const overlay = { get(lookupKey: string) { return lookupKey === key ? replacement : canonical.get(lookupKey); } };
      absent[scenario] = scoreDecisionPlanWeek(week, overlay);
      replacement = { appeared: true, reached60: false, points: 0 };
      appearedAtZero[scenario] = scoreDecisionPlanWeek(week, overlay);
      replacement = { appeared: true, reached60: false, points: 1 };
      pointMultiplier[scenario] = scoreDecisionPlanWeek(week, overlay) - appearedAtZero[scenario];
    }
    scores.push(Object.freeze({ eventId: week.eventId, absent, appearedAtZero, pointMultiplier }));
  }
  return Object.freeze({ decision: context, incomingPlayerId, scores: Object.freeze(scores) });
}

function rescorePreparedIncomingModels(
  context: PreparedTransferSensitivityContext,
  affectedModels: readonly PlayerEventOutcomeModel[],
): DecisionConfidenceResult {
  const unavailable = affectedModels.find(model => model.status === "unavailable");
  if (unavailable?.status === "unavailable") return unavailable;
  const deltas = new Array<number>(context.decision.scenarioCount);
  for (let scenario = 0; scenario < context.decision.scenarioCount; scenario++) {
    const outcomes = sampleDecisionScenario(affectedModels, scenario, context.decision.scenarioCount, context.decision.scenarioFactorDraws);
    let candidatePoints = 0;
    for (const response of context.scores) {
      const outcome = outcomes.get(playerEventOutcomeKey(response.eventId, context.incomingPlayerId));
      if (!outcome) return { status: "unavailable", reason: `Missing affected outcome for incoming player ${context.incomingPlayerId} in event ${response.eventId}.` };
      candidatePoints += outcome.appeared
        ? response.appearedAtZero[scenario] + response.pointMultiplier[scenario] * outcome.points
        : response.absent[scenario];
    }
    deltas[scenario] = candidatePoints - context.decision.baselineScenarioScores[scenario] - context.decision.input.candidateAdditionalHitCost;
  }
  return analyzePreparedDecisionDeltas(context.decision, deltas);
}

export function analyzeTransferBreakEvenSensitivity(input: SensitivityInput): TransferBreakEvenSensitivityResult {
  const prepared = input.context ? { status: "prepared" as const, context: input.context }
    : input.analysis ? prepareDecisionScenarioContext(input.analysis)
    : { status: "unavailable" as const, reason: "Transfer sensitivity inputs are incomplete." };
  if (prepared.status !== "prepared") return prepared;
  const context = prepared.context;
  if (context.scenarioCount !== TRANSFER_SENSITIVITY_LIMITS.scenarioCount) {
    return { status: "unavailable", reason: `Transfer sensitivity requires exactly ${TRANSFER_SENSITIVITY_LIMITS.scenarioCount} canonical scenarios.` };
  }
  const incomingModels = context.input.playerEventModels.filter((model): model is AvailablePlayerEventOutcomeModel =>
    model.status === "available" && model.player.id === input.incomingPlayerId);
  if (!incomingModels.length) return { status: "unavailable", reason: `No available event models exist for incoming player ${input.incomingPlayerId}.` };
  const missingMetadata = incomingModels.find(model => !model.sensitivity);
  if (missingMetadata) return { status: "unavailable", reason: `Player ${input.incomingPlayerId} event ${missingMetadata.eventId} has no sensitivity metadata.` };

  const main = analyzePreparedDecisionContext(context);
  if (!available(main)) return main;
  if (main.preferred === "tie") return { status: "unavailable", reason: "A tied decision has no break-even sensitivity direction." };
  const direction = main.preferred === "candidate" ? "reduction" : "increase";
  const sensitivityContext = prepareIncomingScoreResponses(context, input.incomingPlayerId);
  if ("status" in sensitivityContext) return sensitivityContext;
  const factorOneModels = (input.factorOneModels ?? incomingModels).filter((model): model is AvailablePlayerEventOutcomeModel =>
    model.status === "available" && model.player.id === input.incomingPlayerId);
  const factorOneResult = rescorePreparedIncomingModels(sensitivityContext, factorOneModels);
  if (!available(factorOneResult)) return factorOneResult;
  if (JSON.stringify(factorOneResult) !== JSON.stringify(main)) {
    return { status: "unavailable", reason: "The optimized sensitivity path did not reproduce the canonical factor-1.0 decision result exactly." };
  }

  const evaluate = (factor: TransferSensitivityFactor, scale: number) => {
    try {
      return rescorePreparedIncomingModels(sensitivityContext, incomingModels.map(model => applyPlayerEventSensitivity(model, { factor, scale })));
    } catch (error) {
      return { status: "unavailable" as const, reason: error instanceof Error ? error.message : "Sensitivity model adjustment failed unexpectedly." };
    }
  };

  const search = (factor: TransferSensitivityFactor, endpoint: number, toleranceScale: number, describe: (scale: number) => { threshold: number; message: string }): TransferSensitivityFactorResult => {
    const endpointResult = evaluate(factor, endpoint);
    if (!available(endpointResult)) return { status: "unavailable", factor, reason: endpointResult.reason };
    if (!reversed(endpointResult, direction)) {
      return { status: "unavailable", factor, reason: `The tested valid ${factor.replaceAll("-", " ")} range does not reverse the expected net decision.` };
    }
    let lower = direction === "reduction" ? endpoint : 1;
    let upper = direction === "reduction" ? 1 : endpoint;
    for (let iteration = 0; iteration < TRANSFER_SENSITIVITY_LIMITS.maxBinaryIterations; iteration++) {
      if (upper - lower <= toleranceScale) break;
      const midpoint = (lower + upper) / 2;
      const result = evaluate(factor, midpoint);
      if (!available(result)) return { status: "unavailable", factor, reason: result.reason };
      if (direction === "reduction") {
        if (reversed(result, direction)) lower = midpoint; else upper = midpoint;
      } else {
        if (reversed(result, direction)) upper = midpoint; else lower = midpoint;
      }
    }
    const boundary = direction === "reduction" ? lower : upper;
    const description = describe(boundary);
    return { status: "available", factor, direction: direction === "reduction" ? "below" : "above", ...description };
  };

  const storedExpectedMinutes = incomingModels.map(model => model.sensitivity!.expectedMinutes);
  const expectedMinutes = storedExpectedMinutes.filter(Number.isFinite);
  const baselineExpectedMinutes = average(expectedMinutes);
  const minutesEndpoint = direction === "reduction" ? 0 : baselineExpectedMinutes > 0
    ? Math.min(...expectedMinutes.filter(value => value > 0).map(value => TRANSFER_SENSITIVITY_LIMITS.expectedMinutes.max / value))
    : 1;
  const minutes = expectedMinutes.length !== incomingModels.length
    ? { status: "unavailable" as const, factor: "expected-minutes" as const, reason: "Expected-minutes sensitivity is unavailable because stored baseline expected minutes are non-finite." }
    : baselineExpectedMinutes > 0
    ? search("expected-minutes", minutesEndpoint, TRANSFER_SENSITIVITY_LIMITS.expectedMinutes.toleranceMinutes / baselineExpectedMinutes, scale => {
        const threshold = Math.round(clamp(baselineExpectedMinutes * scale, TRANSFER_SENSITIVITY_LIMITS.expectedMinutes.min, TRANSFER_SENSITIVITY_LIMITS.expectedMinutes.max));
        return { threshold, message: `Break-even: the transfer turns ${direction === "reduction" ? "negative" : "positive"} if ${incomingModels[0].player.name}'s modeled expected minutes ${direction === "reduction" ? "fall below" : "rise above"} ${threshold} per fixture.` };
      })
    : { status: "unavailable" as const, factor: "expected-minutes" as const, reason: "Expected-minutes sensitivity is unavailable because the stored baseline expected minutes are zero." };

  const storedAttackRates = incomingModels.map(model => model.sensitivity!.attackingReturnRate);
  const baselineAttack = average(storedAttackRates);
  const attackEndpoint = direction === "reduction" ? TRANSFER_SENSITIVITY_LIMITS.attackingReturnRate.minScale : TRANSFER_SENSITIVITY_LIMITS.attackingReturnRate.maxScale;
  const attack = storedAttackRates.some(rate => !Number.isFinite(rate))
    ? { status: "unavailable" as const, factor: "attacking-return-rate" as const, reason: "Attacking-return sensitivity is unavailable because the stored modeled attacking rate is non-finite." }
    : baselineAttack > 0
    ? search("attacking-return-rate", attackEndpoint, TRANSFER_SENSITIVITY_LIMITS.attackingReturnRate.toleranceScale, scale => {
        const threshold = Math.round(scale * 100);
        return { threshold, message: `Break-even: the transfer turns ${direction === "reduction" ? "negative" : "positive"} if ${incomingModels[0].player.name}'s modeled attacking return rate ${direction === "reduction" ? "falls below" : "rises above"} ${threshold}% of its current level.` };
      })
    : { status: "unavailable" as const, factor: "attacking-return-rate" as const, reason: "Attacking-return sensitivity is unavailable because the stored modeled attacking rate is zero." };

  const isForward = incomingModels[0].player.positionShort === "FWD";
  const cleanSheetProbabilities = incomingModels.flatMap(model => model.fixtures.filter(fixture => fixture.cleanSheetPoints > 0).map(fixture => fixture.cleanSheetProbability));
  const baselineCleanSheet = average(cleanSheetProbabilities);
  let cleanSheet: TransferSensitivityFactorResult;
  if (isForward) cleanSheet = { status: "unavailable", factor: "clean-sheet-probability", reason: "Clean-sheet points are not position-relevant for forwards." };
  else if (cleanSheetProbabilities.some(probability => !Number.isFinite(probability))) cleanSheet = { status: "unavailable", factor: "clean-sheet-probability", reason: "Clean-sheet sensitivity is unavailable because a stored clean-sheet probability is non-finite." };
  else if (!cleanSheetProbabilities.length || baselineCleanSheet <= 0) cleanSheet = { status: "unavailable", factor: "clean-sheet-probability", reason: "Clean-sheet sensitivity is unavailable because no positive position-relevant clean-sheet probability is modeled." };
  else {
    const maximumCleanSheetScale = Math.min(TRANSFER_SENSITIVITY_LIMITS.cleanSheetProbability.maxScale, 1 / Math.max(...cleanSheetProbabilities));
    const endpoint = direction === "reduction" ? TRANSFER_SENSITIVITY_LIMITS.cleanSheetProbability.minScale : maximumCleanSheetScale;
    cleanSheet = search("clean-sheet-probability", endpoint, TRANSFER_SENSITIVITY_LIMITS.cleanSheetProbability.toleranceProbability / baselineCleanSheet, scale => {
      const threshold = Math.round(clamp(baselineCleanSheet * scale) * 100);
      return { threshold, message: `Break-even: the transfer turns ${direction === "reduction" ? "negative" : "positive"} if ${incomingModels[0].player.name}'s average modeled clean-sheet probability ${direction === "reduction" ? "falls below" : "rises above"} ${threshold}% per fixture.` };
    });
  }

  return {
    status: "available",
    direction,
    factorOneResult,
    factors: Object.freeze([minutes, attack, cleanSheet]),
    assumptions: Object.freeze([
      "Each sensitivity factor varies one scenario-model assumption independently while the optimizer plan, autosub rules, captaincy and every other assumption remain frozen.",
      "Break-even thresholds use the same 1,024 deterministic keyed scenarios as the main result; they are sensitivity boundaries, not calibrated probabilities.",
    ]),
  };
}
