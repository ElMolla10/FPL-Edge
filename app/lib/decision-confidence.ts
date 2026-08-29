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

export type DecisionConfidenceAvailable = {
  status: "available";
  scenarioCount: number;
  availableGameweeks: number;
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

const fnv1a = (text: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const gcd = (left: number, right: number) => {
  let a = Math.abs(left), b = Math.abs(right);
  while (b) [a, b] = [b, a % b];
  return a;
};

// The (multiplier, offset) pair below depends only on (factorKey, scenarioCount), never on
// scenarioIndex -- but analyzeDecisionConfidence calls deterministicStratifiedUnit once per
// scenario, so without this cache the coprime search and both fnv1a hashes were being redone from
// scratch on every single scenario for the same factor. Measured directly (5-gameweek plan, 16
// players/week, 1 fixture each, matching production access patterns): ~97ms -> ~7ms for the same
// 245,760 calls at scenarioCount=1024, with zero output differences across an 1,800-triple spot
// check spanning three different scenarioCounts.
//
// Two-level cache -- outer keyed by scenarioCount (a number, no string build needed), inner keyed
// by factorKey alone (already a string the caller built) -- rather than a single map keyed by a
// concatenated `${factorKey}:${scenarioCount}` string. Both give the same safety: multiplier/offset
// are only valid for the modulus they were computed under, and analyzeDecisionConfidence's
// scenarioCount varies by call site (a lower interactive default vs. a higher batch value), so a
// factorKey-only cache would silently reuse a stale multiplier computed under a different
// scenarioCount. The two-level form was kept because building a fresh concatenated string on every
// call measurably cost more than the coprime search it was meant to avoid (~5x slower than this).
const stratifiedFactorCache = new Map<number, Map<string, { multiplier: number; offset: number }>>();
function stratifiedFactor(scenarioCount: number, factorKey: string): { multiplier: number; offset: number } {
  let byFactorKey = stratifiedFactorCache.get(scenarioCount);
  if (!byFactorKey) { byFactorKey = new Map(); stratifiedFactorCache.set(scenarioCount, byFactorKey); }
  const cached = byFactorKey.get(factorKey);
  if (cached) return cached;
  let multiplier = (fnv1a(`a:${factorKey}`) % scenarioCount) || 1;
  while (gcd(multiplier, scenarioCount) !== 1) multiplier = (multiplier + 1) % scenarioCount || 1;
  const offset = fnv1a(`b:${factorKey}`) % scenarioCount;
  const entry = { multiplier, offset };
  byFactorKey.set(factorKey, entry);
  return entry;
}

/**
 * Deterministic stratified sampling. For N scenarios, each factor visits every stratum
 * `(k+.5)/N` exactly once. A stable FNV-1a hash chooses a factor-specific affine permutation
 * `(a*i+b) mod N`; `a` is advanced until coprime with N, making it a true permutation for any N.
 * Identical factor keys therefore receive identical samples in baseline and candidate plans.
 * There is no PRNG, Math.random(), clock or mutable global state.
 */
export function deterministicStratifiedUnit(scenarioIndex: number, scenarioCount: number, factorKey: string): number {
  if (!Number.isInteger(scenarioCount) || scenarioCount < 1) throw new Error("scenarioCount must be a positive integer");
  if (!Number.isInteger(scenarioIndex) || scenarioIndex < 0 || scenarioIndex >= scenarioCount) throw new Error("scenarioIndex is outside the scenario range");
  const { multiplier, offset } = stratifiedFactor(scenarioCount, factorKey);
  const stratum = (multiplier * scenarioIndex + offset) % scenarioCount;
  return (stratum + .5) / scenarioCount;
}

export function sampleDecisionScenario(
  models: readonly PlayerEventOutcomeModel[],
  scenarioIndex: number,
  scenarioCount: number,
): ReadonlyMap<string, JointPlayerOutcome> {
  const outcomes = new Map<string, JointPlayerOutcome>();
  for (const model of models) {
    let appeared = false, reached60 = false, points = 0;
    for (const fixture of model.fixtures) {
      const base = `${model.eventId}:${model.player.id}:${fixture.fixtureId}`;
      const appearanceDraw = deterministicStratifiedUnit(scenarioIndex, scenarioCount, `appearance:${base}`);
      const fixtureAppeared = appearanceDraw < clamp(fixture.appearanceProbability);
      if (!fixtureAppeared) continue;
      const fixtureReached60 = appearanceDraw < clamp(fixture.reached60Probability, 0, fixture.appearanceProbability);
      appeared = true;
      reached60 ||= fixtureReached60;
      points += fixtureReached60 ? 2 : 1;
      points += samplePmf(fixture.pointsWhenAppearedPmf, deterministicStratifiedUnit(scenarioIndex, scenarioCount, `scoring:${base}`));
      const cleanSheetDraw = deterministicStratifiedUnit(scenarioIndex, scenarioCount, `clean-sheet:${fixture.fixtureId}:${fixture.teamId}`);
      if (fixtureReached60 && cleanSheetDraw < clamp(fixture.cleanSheetProbability)) points += fixture.cleanSheetPoints;
    }
    outcomes.set(playerEventOutcomeKey(model.eventId, model.player.id), { appeared, reached60, points });
  }
  return outcomes;
}

function playerWithOutcome(player: FplPlayer, eventId: number, outcomes: ReadonlyMap<string, JointPlayerOutcome>): FplPlayer {
  const outcome = outcomes.get(playerEventOutcomeKey(eventId, player.id));
  if (!outcome) throw new Error(`Missing modeled outcome for player ${player.id} in event ${eventId}.`);
  return { ...player, eventMinutes: outcome.appeared ? outcome.reached60 ? 60 : 1 : 0, eventPoints: outcome.points };
}

export function scoreDecisionPlanWeek(week: FrozenDecisionWeek, outcomes: ReadonlyMap<string, JointPlayerOutcome>): number {
  const xi = week.xi.map(player => playerWithOutcome(player, week.eventId, outcomes));
  const bench = week.bench.map(player => playerWithOutcome(player, week.eventId, outcomes));
  const resolved = simulateAutosubs(xi, bench, week.captainId, week.viceId);
  const basePoints = resolved.effectiveXi.reduce((sum, player) => sum + player.eventPoints, 0);
  if (resolved.effectiveCaptainId === null) return basePoints;
  const captain = resolved.effectiveXi.find(player => player.id === resolved.effectiveCaptainId);
  return basePoints + (captain?.eventPoints ?? 0) * (week.captainMultiplier - 1);
}

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
  const modelKeys = new Set(input.playerEventModels.map(model => playerEventOutcomeKey(model.eventId, model.player.id)));
  for (const plan of [input.baseline, input.candidate]) for (const week of plan.weeks) for (const player of [...week.xi, ...week.bench]) {
    if (!modelKeys.has(playerEventOutcomeKey(week.eventId, player.id))) return `Missing outcome model for player ${player.id} in event ${week.eventId}.`;
  }
  if (!Number.isInteger(input.scenarioCount ?? 1024) || (input.scenarioCount ?? 1024) < 1 || (input.scenarioCount ?? 1024) > 2048) return "Scenario count must be an integer from 1 to 2048.";
  if (!Number.isFinite(input.candidateAdditionalHitCost)) return "Candidate additional hit cost must be finite.";
  return null;
}

export function analyzeDecisionConfidence(input: DecisionConfidenceInput): DecisionConfidenceResult {
  const reason = unavailableReason(input);
  if (reason) return { status: "unavailable", reason };
  const scenarioCount = input.scenarioCount ?? 1024;
  const deltas: number[] = [];
  for (let scenario = 0; scenario < scenarioCount; scenario++) {
    const outcomes = sampleDecisionScenario(input.playerEventModels, scenario, scenarioCount);
    const baselinePoints = input.baseline.weeks.reduce((sum, week) => sum + scoreDecisionPlanWeek(week, outcomes), 0);
    const candidatePoints = input.candidate.weeks.reduce((sum, week) => sum + scoreDecisionPlanWeek(week, outcomes), 0);
    deltas.push(candidatePoints - baselinePoints - input.candidateAdditionalHitCost);
  }
  const sorted = [...deltas].sort((a, b) => a - b);
  const gainCount = deltas.filter(delta => delta > 0).length;
  const tieCount = deltas.filter(delta => delta === 0).length;
  const lossCount = deltas.length - gainCount - tieCount;
  const total = deltas.reduce((sum, delta) => sum + delta, 0);
  const expectedDelta = total === 0 ? 0 : total / scenarioCount;
  const preferred = expectedDelta > 0 ? "candidate" : expectedDelta < 0 ? "baseline" : "tie";
  const preferredAlternativeScenarioWinRate = preferred === "candidate" ? gainCount / scenarioCount : preferred === "baseline" ? lossCount / scenarioCount : null;
  return {
    status: "available",
    scenarioCount,
    availableGameweeks: input.baseline.weeks.length,
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
  };
}
