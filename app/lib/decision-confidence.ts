import type { FplPlayer } from "./fpl";
import { simulateAutosubs } from "./fpl";
import type { PlayerEventOutcomeModel } from "./projection-distribution";
import { samplePmf } from "./projection-distribution";

export type JointPlayerOutcome = {
  appeared: boolean;
  reached60: boolean;
  points: number;
};

export type DecisionWeekInput = {
  eventId: number;
  xi: readonly FplPlayer[];
  bench: readonly FplPlayer[];
  captain: FplPlayer;
  vice: FplPlayer;
  captainMultiplier: 2 | 3;
};

export type FrozenDecisionWeek = Readonly<{
  eventId: number;
  xi: readonly FplPlayer[];
  bench: readonly FplPlayer[];
  captainId: number;
  viceId: number;
  captainMultiplier: 2 | 3;
}>;

export type FrozenDecisionPlan = Readonly<{
  id: string;
  weeks: readonly FrozenDecisionWeek[];
}>;

export type DecisionPlanInput = {
  id: string;
  weeks: readonly DecisionWeekInput[];
};

export type ScenarioFrequency = { count: number; rate: number };
export type DecisionConfidenceLabel = "Robust" | "Close call" | "High-risk";
/**
 * Describes which projection regime produced the result, not a calibrated confidence score (this
 * app has no basis to calibrate one). Only the first modeled gameweek ever blends in FPL's own
 * official estimate; "extended" names the range where more gameweeks of this app's own
 * current-form-held-constant model have accumulated without that anchor.
 */
export type DecisionHorizonTier = "near-term" | "extended";
// 1-5 GW is the range this engine has always run at (matches this app's own existing "Balanced 5
// GWs" convention elsewhere); 6-8 GW is the range Phase 2 newly unlocks (matches the app's own
// "Long-term 8 GWs" optimizer ceiling), and it deserves visibly stronger disclosure, not the same
// confident presentation as a 1-5 GW result.
export const EXTENDED_DECISION_HORIZON_GAMEWEEKS = 6;

export type DecisionConfidenceAvailable = {
  status: "available";
  scenarioCount: number;
  availableGameweeks: number;
  horizonTier: DecisionHorizonTier;
  frequencies: {
    gain: ScenarioFrequency;
    tie: ScenarioFrequency;
    loss: ScenarioFrequency;
  };
  expectedDelta: number;
  p10: number;
  p50: number;
  p90: number;
  preferred: "baseline" | "candidate" | "tie";
  /**
   * The fraction of deterministic modeled scenarios in which the preferred alternative strictly
   * wins. This is a modeled scenario win rate, not a calibrated probability or a guarantee.
   */
  preferredAlternativeScenarioWinRate: number | null;
  label: DecisionConfidenceLabel;
  assumptions: readonly string[];
};

export type DecisionConfidenceUnavailable = {
  status: "unavailable";
  reason: string;
};

export type DecisionConfidenceResult = DecisionConfidenceAvailable | DecisionConfidenceUnavailable;

export type DecisionConfidenceInput = {
  baseline: FrozenDecisionPlan;
  candidate: FrozenDecisionPlan;
  playerEventModels: readonly PlayerEventOutcomeModel[];
  candidateAdditionalHitCost: number;
  scenarioCount?: number;
};

type OutcomeLookup = Pick<ReadonlyMap<string, JointPlayerOutcome>, "get">;

export type PreparedDecisionScenarioContext = Readonly<{
  input: DecisionConfidenceInput;
  scenarioCount: number;
  scenarioOutcomes: readonly ReadonlyMap<string, JointPlayerOutcome>[];
  scenarioFactorDraws: ReadonlyMap<string, Float64Array>;
  baselineScenarioScores: readonly number[];
  canonicalCandidateScores: readonly number[];
  canonicalDeltas: readonly number[];
}>;

export type PreparedDecisionScenarioResult =
  | { status: "prepared"; context: PreparedDecisionScenarioContext }
  | DecisionConfidenceUnavailable;

export function decisionScenarioCountUnavailableReason(scenarioCount = 1024): string | null {
  return Number.isInteger(scenarioCount) && scenarioCount >= 1 && scenarioCount <= 2048
    ? null
    : "Scenario count must be an integer from 1 to 2048.";
}

// Selection is frozen into id lists before simulation. The optimizer is never called here and no
// scenario can revise the XI, bench order, captain, vice or multiplier after outcomes are known.
export function freezeDecisionPlan(input: DecisionPlanInput): FrozenDecisionPlan {
  const weeks = input.weeks.map((week): FrozenDecisionWeek => Object.freeze({
    eventId: week.eventId,
    xi: Object.freeze(week.xi.map(player => Object.freeze({ ...player }))),
    bench: Object.freeze(week.bench.map(player => Object.freeze({ ...player }))),
    captainId: week.captain.id,
    viceId: week.vice.id,
    captainMultiplier: week.captainMultiplier,
  }));
  return Object.freeze({ id: input.id, weeks: Object.freeze(weeks) });
}

export const playerEventOutcomeKey = (eventId: number, playerId: number) => `${eventId}:${playerId}`;

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

// cyrb128 + sfc32 are deterministic integer-only hash/PRNG primitives. They are not used as a
// probability source: each factor's PRNG only shuffles the complete [0,N) stratum list, so every
// factor still visits every stratum exactly once. Four seeded words avoid collapsing unrelated
// football factor keys onto the shared slope/intercept structure of the previous affine scheme.
function cyrb128(text: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

function seededUnit(seed: [number, number, number, number]): () => number {
  let [a, b, c, d] = seed;
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const result = (a + b + d) >>> 0;
    d = (d + 1) >>> 0;
    a = (b ^ (b >>> 9)) >>> 0;
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + result) >>> 0;
    return result / 4294967296;
  };
}

const MAX_CACHED_PERMUTATIONS = 2048;
const keyedPermutationCache = new Map<string, Uint16Array>();

function keyedPermutation(scenarioCount: number, factorKey: string): Uint16Array {
  const cacheKey = `${scenarioCount}\0${factorKey}`;
  const cached = keyedPermutationCache.get(cacheKey);
  if (cached) return cached;
  const permutation = Uint16Array.from({ length: scenarioCount }, (_, index) => index);
  const random = seededUnit(cyrb128(cacheKey));
  for (let index = scenarioCount - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    const value = permutation[index];
    permutation[index] = permutation[swapIndex];
    permutation[swapIndex] = value;
  }
  if (keyedPermutationCache.size >= MAX_CACHED_PERMUTATIONS) {
    const oldest = keyedPermutationCache.keys().next().value;
    if (oldest !== undefined) keyedPermutationCache.delete(oldest);
  }
  keyedPermutationCache.set(cacheKey, permutation);
  return permutation;
}

/**
 * Deterministic keyed Fisher-Yates stratification. For N scenarios, each factor visits every
 * stratum `(k+.5)/N` exactly once. Identical keys reproduce the same permutation; different keys
 * receive independently seeded shuffles rather than sharing affine dependence. The FIFO cache is
 * capped at 2,048 permutations (at most 8 MiB at the supported N=2,048), and eviction cannot alter
 * results because a key's permutation is reproducible from the key itself. No Math.random or clock.
 */
export function deterministicStratifiedUnit(scenarioIndex: number, scenarioCount: number, factorKey: string): number {
  if (!Number.isInteger(scenarioCount) || scenarioCount < 1) throw new Error("scenarioCount must be a positive integer");
  if (!Number.isInteger(scenarioIndex) || scenarioIndex < 0 || scenarioIndex >= scenarioCount) throw new Error("scenarioIndex is outside the scenario range");
  const stratum = keyedPermutation(scenarioCount, factorKey)[scenarioIndex];
  return (stratum + .5) / scenarioCount;
}

export function sampleDecisionScenario(
  models: readonly PlayerEventOutcomeModel[],
  scenarioIndex: number,
  scenarioCount: number,
  preparedDraws?: ReadonlyMap<string, Float64Array>,
): ReadonlyMap<string, JointPlayerOutcome> {
  const outcomes = new Map<string, JointPlayerOutcome>();
  const draw = (factorKey: string) => preparedDraws?.get(factorKey)?.[scenarioIndex] ?? deterministicStratifiedUnit(scenarioIndex, scenarioCount, factorKey);
  for (const model of models) {
    if (model.status === "unavailable") throw new Error(model.reason);
    let appeared = false, reached60 = false, points = 0;
    for (const fixture of model.fixtures) {
      const base = `${model.eventId}:${model.player.id}:${fixture.fixtureId}`;
      const appearanceDraw = draw(`appearance:${base}`);
      const fixtureAppeared = appearanceDraw < clamp(fixture.appearanceProbability);
      if (!fixtureAppeared) continue;
      const fixtureReached60 = appearanceDraw < clamp(fixture.reached60Probability, 0, fixture.appearanceProbability);
      appeared = true;
      reached60 ||= fixtureReached60;
      points += fixtureReached60 ? 2 : 1;
      points += samplePmf(fixture.pointsWhenAppearedPmf, draw(`scoring:${base}`));
      const cleanSheetDraw = draw(`clean-sheet:${fixture.fixtureId}:${fixture.teamId}`);
      if (fixtureReached60 && cleanSheetDraw < clamp(fixture.cleanSheetProbability)) points += fixture.cleanSheetPoints;
    }
    outcomes.set(playerEventOutcomeKey(model.eventId, model.player.id), { appeared, reached60, points });
  }
  return outcomes;
}

function playerWithOutcome(player: FplPlayer, eventId: number, outcomes: OutcomeLookup): FplPlayer {
  const outcome = outcomes.get(playerEventOutcomeKey(eventId, player.id));
  if (!outcome) throw new Error(`Missing modeled outcome for player ${player.id} in event ${eventId}.`);
  return { ...player, eventMinutes: outcome.appeared ? outcome.reached60 ? 60 : 1 : 0, eventPoints: outcome.points };
}

export function scoreDecisionPlanWeek(week: FrozenDecisionWeek, outcomes: OutcomeLookup): number {
  const xi = week.xi.map(player => playerWithOutcome(player, week.eventId, outcomes));
  const bench = week.bench.map(player => playerWithOutcome(player, week.eventId, outcomes));
  const resolved = simulateAutosubs(xi, bench, week.captainId, week.viceId);
  const basePoints = resolved.effectiveXi.reduce((sum, player) => sum + player.eventPoints, 0);
  if (resolved.effectiveCaptainId === null) return basePoints;
  const captain = resolved.effectiveXi.find(player => player.id === resolved.effectiveCaptainId);
  return basePoints + (captain?.eventPoints ?? 0) * (week.captainMultiplier - 1);
}

const scoreDecisionPlan = (plan: FrozenDecisionPlan, outcomes: OutcomeLookup) =>
  plan.weeks.reduce((sum, week) => sum + scoreDecisionPlanWeek(week, outcomes), 0);

function quantile(sorted: readonly number[], probability: number): number {
  const index = Math.max(0, Math.ceil(clamp(probability) * sorted.length) - 1);
  return sorted[Math.min(sorted.length - 1, index)];
}

export function classifyDecisionConfidence(deltas: readonly number[], expectedDelta: number): DecisionConfidenceLabel {
  if (!deltas.length || expectedDelta === 0) return "Close call";
  const direction = expectedDelta > 0 ? 1 : -1;
  const advantages = deltas.map(delta => delta * direction).sort((a, b) => a - b);
  const p10 = quantile(advantages, .1);
  if (p10 > 0) return "Robust";
  const p25 = quantile(advantages, .25), p75 = quantile(advantages, .75);
  if (p25 <= 0 && p75 >= 0) return "Close call";
  return "High-risk";
}

const planEventIds = (plan: FrozenDecisionPlan) => plan.weeks.map(week => week.eventId);

function unavailableReason(input: DecisionConfidenceInput): string | null {
  const baselineEvents = planEventIds(input.baseline), candidateEvents = planEventIds(input.candidate);
  if (!baselineEvents.length || !candidateEvents.length) return "No shared future events are available for decision analysis.";
  if (baselineEvents.length !== candidateEvents.length || baselineEvents.some((eventId, index) => eventId !== candidateEvents[index])) return "Baseline and candidate plans do not cover the same future events.";
  const unavailableModel = input.playerEventModels.find(model => model.status === "unavailable");
  if (unavailableModel?.status === "unavailable") return unavailableModel.reason;
  const modelKeys = new Set<string>();
  for (const model of input.playerEventModels) {
    const key = playerEventOutcomeKey(model.eventId, model.player.id);
    if (modelKeys.has(key)) return `Duplicate outcome model for player ${model.player.id} in event ${model.eventId}.`;
    modelKeys.add(key);
  }
  for (const plan of [input.baseline, input.candidate]) for (const week of plan.weeks) for (const player of [...week.xi, ...week.bench]) {
    if (!modelKeys.has(playerEventOutcomeKey(week.eventId, player.id))) return `Missing outcome model for player ${player.id} in event ${week.eventId}.`;
  }
  const scenarioReason = decisionScenarioCountUnavailableReason(input.scenarioCount);
  if (scenarioReason) return scenarioReason;
  if (!Number.isFinite(input.candidateAdditionalHitCost)) return "Candidate additional hit cost must be finite.";
  return null;
}

function summarizeDecisionDeltas(input: DecisionConfidenceInput, deltas: readonly number[]): DecisionConfidenceAvailable {
  const scenarioCount = deltas.length;
  const sorted = [...deltas].sort((a, b) => a - b);
  const gainCount = deltas.filter(delta => delta > 0).length;
  const tieCount = deltas.filter(delta => delta === 0).length;
  const lossCount = deltas.length - gainCount - tieCount;
  const total = deltas.reduce((sum, delta) => sum + delta, 0);
  const expectedDelta = total === 0 ? 0 : total / scenarioCount;
  const preferred = expectedDelta > 0 ? "candidate" : expectedDelta < 0 ? "baseline" : "tie";
  const preferredAlternativeScenarioWinRate = preferred === "candidate" ? gainCount / scenarioCount : preferred === "baseline" ? lossCount / scenarioCount : null;
  const availableGameweeks = input.baseline.weeks.length;
  const horizonTier: DecisionHorizonTier = availableGameweeks >= EXTENDED_DECISION_HORIZON_GAMEWEEKS ? "extended" : "near-term";
  const assumptions = [...new Set([
    "Modeled scenario frequencies and the modeled scenario win rate are deterministic simulation frequencies, not calibrated probabilities or guarantees.",
    "Baseline and candidate selections, bench order, captaincy and captain multiplier are frozen before scenario outcomes are sampled.",
    "Only the first modeled gameweek blends in FPL's own official next-gameweek estimate; every gameweek after that runs entirely on this app's current-form projection model, held constant for the rest of the horizon.",
    ...(horizonTier === "extended"
      ? ["This analysis spans 6 or more gameweeks. The longer the horizon, the more it assumes today's form, team strength and fixtures hold unchanged -- squad transfers, injuries and role changes that would normally occur over that many weeks are not modeled. Treat this as a directional read, not a precise forecast."]
      : []),
    ...input.playerEventModels.flatMap(model => model.status === "available" ? model.audit.assumptions : []),
  ])];
  return {
    status: "available",
    scenarioCount,
    availableGameweeks,
    horizonTier,
    frequencies: {
      gain: { count: gainCount, rate: gainCount / scenarioCount },
      tie: { count: tieCount, rate: tieCount / scenarioCount },
      loss: { count: lossCount, rate: lossCount / scenarioCount },
    },
    expectedDelta,
    p10: quantile(sorted, .1),
    p50: quantile(sorted, .5),
    p90: quantile(sorted, .9),
    preferred,
    preferredAlternativeScenarioWinRate,
    label: classifyDecisionConfidence(deltas, expectedDelta),
    assumptions,
  };
}

/**
 * Builds the reusable deterministic scenario context used by both canonical analysis and transfer
 * sensitivity. Every player/event outcome is sampled once, while baseline and canonical candidate
 * scores are retained so later sensitivity evaluations only need to overlay the affected models.
 */
export function prepareDecisionScenarioContext(input: DecisionConfidenceInput): PreparedDecisionScenarioResult {
  const reason = unavailableReason(input);
  if (reason) return { status: "unavailable", reason };
  const scenarioCount = input.scenarioCount ?? 1024;
  const scenarioOutcomes: ReadonlyMap<string, JointPlayerOutcome>[] = [];
  const baselineScenarioScores: number[] = [];
  const canonicalCandidateScores: number[] = [];
  const canonicalDeltas: number[] = [];
  const factorKeys = new Set<string>();
  for (const model of input.playerEventModels) {
    if (model.status === "unavailable") continue;
    for (const fixture of model.fixtures) {
      const base = `${model.eventId}:${model.player.id}:${fixture.fixtureId}`;
      factorKeys.add(`appearance:${base}`);
      factorKeys.add(`scoring:${base}`);
      factorKeys.add(`clean-sheet:${fixture.fixtureId}:${fixture.teamId}`);
    }
  }
  const scenarioFactorDraws = new Map<string, Float64Array>();
  for (const factorKey of factorKeys) {
    const draws = new Float64Array(scenarioCount);
    for (let scenario = 0; scenario < scenarioCount; scenario++) draws[scenario] = deterministicStratifiedUnit(scenario, scenarioCount, factorKey);
    scenarioFactorDraws.set(factorKey, draws);
  }
  for (let scenario = 0; scenario < scenarioCount; scenario++) {
    const outcomes = sampleDecisionScenario(input.playerEventModels, scenario, scenarioCount, scenarioFactorDraws);
    const baselinePoints = scoreDecisionPlan(input.baseline, outcomes);
    const candidatePoints = scoreDecisionPlan(input.candidate, outcomes);
    scenarioOutcomes.push(outcomes);
    baselineScenarioScores.push(baselinePoints);
    canonicalCandidateScores.push(candidatePoints);
    canonicalDeltas.push(candidatePoints - baselinePoints - input.candidateAdditionalHitCost);
  }
  return {
    status: "prepared",
    context: Object.freeze({
      input,
      scenarioCount,
      scenarioOutcomes: Object.freeze(scenarioOutcomes),
      scenarioFactorDraws,
      baselineScenarioScores: Object.freeze(baselineScenarioScores),
      canonicalCandidateScores: Object.freeze(canonicalCandidateScores),
      canonicalDeltas: Object.freeze(canonicalDeltas),
    }),
  };
}

export function analyzePreparedDecisionContext(context: PreparedDecisionScenarioContext): DecisionConfidenceResult {
  return summarizeDecisionDeltas(context.input, context.canonicalDeltas);
}

export function analyzePreparedDecisionDeltas(
  context: PreparedDecisionScenarioContext,
  deltas: readonly number[],
): DecisionConfidenceResult {
  if (deltas.length !== context.scenarioCount || deltas.some(delta => !Number.isFinite(delta))) {
    return { status: "unavailable", reason: "Prepared scenario deltas must be finite and match the canonical scenario count." };
  }
  return summarizeDecisionDeltas(context.input, deltas);
}

export function rescorePreparedDecisionCandidate(
  context: PreparedDecisionScenarioContext,
  affectedModels: readonly PlayerEventOutcomeModel[],
): DecisionConfidenceResult {
  const unavailable = affectedModels.find(model => model.status === "unavailable");
  if (unavailable?.status === "unavailable") return unavailable;
  const deltas: number[] = [];
  for (let scenario = 0; scenario < context.scenarioCount; scenario++) {
    const affectedOutcomes = sampleDecisionScenario(affectedModels, scenario, context.scenarioCount, context.scenarioFactorDraws);
    const canonicalOutcomes = context.scenarioOutcomes[scenario];
    const overlay: OutcomeLookup = {
      get(key) { return affectedOutcomes.get(key) ?? canonicalOutcomes.get(key); },
    };
    const candidatePoints = scoreDecisionPlan(context.input.candidate, overlay);
    deltas.push(candidatePoints - context.baselineScenarioScores[scenario] - context.input.candidateAdditionalHitCost);
  }
  return summarizeDecisionDeltas(context.input, deltas);
}

export function analyzeDecisionConfidence(input: DecisionConfidenceInput): DecisionConfidenceResult {
  const prepared = prepareDecisionScenarioContext(input);
  return prepared.status === "prepared" ? analyzePreparedDecisionContext(prepared.context) : prepared;
}
