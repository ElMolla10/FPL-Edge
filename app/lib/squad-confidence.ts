import type { FplFixture, FplPlayer } from "./fpl";
import type { SquadEvaluation, WeekPlan } from "./optimizer";
import type { PlayerEventOutcomeModel } from "./projection-distribution";
import { buildPlayerEventOutcomeModel } from "./projection-distribution";
import {
  DecisionConfidenceInput,
  DecisionConfidenceResult,
  DecisionWeekInput,
  analyzeDecisionConfidence,
  decisionScenarioCountUnavailableReason,
  freezeDecisionPlan,
} from "./decision-confidence";

export const DEFAULT_DECISION_SCENARIO_COUNT = 1024;
// Matches this app's own existing "Long-term 8 GWs" optimizer ceiling (optimizer.ts,
// LiveDraftBuilder.tsx) rather than a freshly invented number -- there is no principled point
// between 6 and 8 GW where the model's constant-rate assumption becomes newly wrong; degradation
// is continuous, not a cliff. Results at 6-8 GW carry a visible "extended" disclosure (see
// DecisionHorizonTier in decision-confidence.ts) rather than presenting with the same confidence
// as the 1-5 GW range this engine has always run at.
export const MAX_DECISION_HORIZON = 8;
const STANDARD_CAPTAIN_MULTIPLIER = 2 as const;

const toDecisionWeek = (week: WeekPlan): DecisionWeekInput => ({
  eventId: week.eventId,
  xi: week.xi,
  bench: week.bench,
  captain: week.captain,
  vice: week.vice,
  captainMultiplier: STANDARD_CAPTAIN_MULTIPLIER,
});

export type SquadDecisionConfidenceInput = {
  fixtures: FplFixture[];
  futureEventIds: readonly number[];
  dataUpdatedAt: string;
  baselineSquad: readonly FplPlayer[];
  candidateSquad: readonly FplPlayer[];
  baselineEvaluation: SquadEvaluation;
  candidateEvaluation: SquadEvaluation;
  candidateAdditionalHitCost: number;
  scenarioCount?: number;
};

export type PreparedSquadDecisionConfidence =
  | { status: "prepared"; analysis: DecisionConfidenceInput }
  | { status: "unavailable"; reason: string };

/**
 * Bounded LRU cache for immutable player/event models. A feed timestamp, first event, event and
 * player identify every projection input used by the model. Updating official data naturally
 * changes the key, while undo/reset can reuse the exact same models without storing a result.
 */
export class PlayerEventModelCache {
  readonly #models = new Map<string, PlayerEventOutcomeModel>();

  constructor(readonly maxEntries = 512) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("Player-event model cache size must be a positive integer.");
  }

  get size(): number { return this.#models.size; }

  getOrBuild(key: string, build: () => PlayerEventOutcomeModel): PlayerEventOutcomeModel {
    const existing = this.#models.get(key);
    if (existing) {
      this.#models.delete(key);
      this.#models.set(key, existing);
      return existing;
    }
    const model = build();
    if (this.#models.size >= this.maxEntries) {
      const oldest = this.#models.keys().next().value;
      if (oldest !== undefined) this.#models.delete(oldest);
    }
    this.#models.set(key, model);
    return model;
  }
}

const eventIdsFor = (evaluation: SquadEvaluation) => evaluation.weeks.map(week => week.eventId);
const matchesHorizon = (actual: readonly number[], expected: readonly number[]) =>
  actual.length === expected.length && actual.every((eventId, index) => eventId === expected[index]);

function squadUnavailableReason(input: SquadDecisionConfidenceInput): string | null {
  if (!input || !Array.isArray(input.fixtures) || !Array.isArray(input.futureEventIds) || !Array.isArray(input.baselineSquad) || !Array.isArray(input.candidateSquad)) {
    return "Squad decision analysis inputs are incomplete or invalid.";
  }
  if (!input.futureEventIds.length) return "No future events are available for squad decision analysis.";
  if (input.futureEventIds.length > MAX_DECISION_HORIZON) return `Decision Confidence supports at most ${MAX_DECISION_HORIZON} future events.`;
  if (input.futureEventIds.some(eventId => !Number.isInteger(eventId) || eventId < 1) || new Set(input.futureEventIds).size !== input.futureEventIds.length) {
    return "Future event IDs must be unique positive integers.";
  }
  const scenarioReason = decisionScenarioCountUnavailableReason(input.scenarioCount);
  if (scenarioReason) return scenarioReason;
  if (!Number.isFinite(input.candidateAdditionalHitCost)) return "Candidate additional hit cost must be finite.";
  if (input.baselineSquad.length !== 15 || input.candidateSquad.length !== 15) return "Decision Confidence requires two complete 15-player squads.";
  if (new Set(input.baselineSquad.map(player => player.id)).size !== 15 || new Set(input.candidateSquad.map(player => player.id)).size !== 15) {
    return "Decision Confidence squads must contain 15 unique players.";
  }
  const positionShape = (squad: readonly FplPlayer[]) => ["GKP", "DEF", "MID", "FWD"].map(position => squad.filter(player => player.positionShort === position).length).join(":");
  if (positionShape(input.baselineSquad) !== "2:5:5:3" || positionShape(input.candidateSquad) !== "2:5:5:3") {
    return "Decision Confidence requires complete squads with the official 2-5-5-3 position structure.";
  }
  if (!input.baselineEvaluation || !input.candidateEvaluation) return "Squad evaluations are unavailable.";
  if (!matchesHorizon(eventIdsFor(input.baselineEvaluation), input.futureEventIds) || !matchesHorizon(eventIdsFor(input.candidateEvaluation), input.futureEventIds)) {
    return "Baseline and candidate evaluations do not cover the explicit future event horizon.";
  }
  return null;
}

export function prepareSquadDecisionConfidence(
  input: SquadDecisionConfidenceInput,
  cache = new PlayerEventModelCache(),
): PreparedSquadDecisionConfidence {
  const reason = squadUnavailableReason(input);
  if (reason) return { status: "unavailable", reason };
  const baseline = freezeDecisionPlan({ id: "baseline", weeks: input.baselineEvaluation.weeks.map(toDecisionWeek) });
  const candidate = freezeDecisionPlan({ id: "candidate", weeks: input.candidateEvaluation.weeks.map(toDecisionWeek) });
  const firstEventId = input.futureEventIds[0];
  const playersByEvent = new Map<number, Map<number, FplPlayer>>();
  for (const evaluation of [input.baselineEvaluation, input.candidateEvaluation]) {
    for (const week of evaluation.weeks) {
      const players = playersByEvent.get(week.eventId) ?? new Map<number, FplPlayer>();
      for (const player of [...week.xi, ...week.bench]) players.set(player.id, player);
      playersByEvent.set(week.eventId, players);
    }
  }
  const playerEventModels = input.futureEventIds.flatMap(eventId =>
    [...(playersByEvent.get(eventId)?.values() ?? [])].map(player => {
      const cacheKey = `${input.dataUpdatedAt}\0${firstEventId}\0${eventId}\0${player.id}`;
      return cache.getOrBuild(cacheKey, () => buildPlayerEventOutcomeModel(player, eventId, input.fixtures, firstEventId));
    }),
  );
  return {
    status: "prepared",
    analysis: {
      baseline,
      candidate,
      playerEventModels,
      candidateAdditionalHitCost: input.candidateAdditionalHitCost,
      scenarioCount: input.scenarioCount ?? DEFAULT_DECISION_SCENARIO_COUNT,
    },
  };
}

export function analyzeSquadDecisionConfidence(
  input: SquadDecisionConfidenceInput,
  cache?: PlayerEventModelCache,
): DecisionConfidenceResult {
  const prepared = prepareSquadDecisionConfidence(input, cache);
  return prepared.status === "prepared" ? analyzeDecisionConfidence(prepared.analysis) : prepared;
}

