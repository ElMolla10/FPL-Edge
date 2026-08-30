import type { FplFixture, FplPlayer } from "./fpl";
import type { SquadEvaluation, WeekPlan } from "./optimizer";
import type { Transfer } from "./transfers";
import { buildPlayerEventOutcomeModel } from "./projection-distribution";
import { DecisionConfidenceResult, DecisionWeekInput, analyzeDecisionConfidence, decisionScenarioCountUnavailableReason, freezeDecisionPlan } from "./decision-confidence";

// Batch-shaped default (not re-run on every keystroke): the top-ranked candidate only, computed once
// per squad/transfer pair the caller memoizes. 1024 is the batch default measured for this engine, not
// the interactive one -- a future live per-swap recompute should pass a lower override.
const DEFAULT_SCENARIO_COUNT = 1024;

// No chip is modeled yet (Bench Boost/Triple Captain/Free Hit are a later phase), so every week is
// frozen at the standard x2 captain multiplier, matching what optimizer.evaluate() itself assumes.
const STANDARD_CAPTAIN_MULTIPLIER = 2 as const;

function toDecisionWeek(week: WeekPlan): DecisionWeekInput {
  return { eventId: week.eventId, xi: week.xi, bench: week.bench, captain: week.captain, vice: week.vice, captainMultiplier: STANDARD_CAPTAIN_MULTIPLIER };
}

export type TransferDecisionConfidenceInput = {
  fixtures: FplFixture[];
  futureEventIds: readonly number[];
  squad: readonly FplPlayer[];
  transfer: Pick<Transfer, "out" | "incoming" | "hitCost">;
  evaluate: (squad: FplPlayer[]) => SquadEvaluation;
  scenarioCount?: number;
};

// Builds the baseline-vs-candidate plan pair for a single already-ranked transfer and hands it to the
// Decision Confidence Engine. Reuses the SAME optimizer instance's evaluate() the rest of the
// Transfers page already calls per candidate row (withModelUtilityChange does an equivalent
// evaluate(swapped) already) -- this adds one more evaluate() call for whichever single candidate the
// caller passes in, not a new search or a second optimizer.
export function analyzeTransferDecisionConfidence(input: TransferDecisionConfidenceInput): DecisionConfidenceResult {
  if (!input || !Array.isArray(input.fixtures) || !Array.isArray(input.futureEventIds) || !Array.isArray(input.squad) || typeof input.evaluate !== "function" || !input.transfer?.out || !input.transfer?.incoming) {
    return { status: "unavailable", reason: "Transfer decision analysis inputs are incomplete or invalid." };
  }
  if (!input.futureEventIds.length) return { status: "unavailable", reason: "No future events are available for transfer decision analysis." };
  if (input.futureEventIds.some(eventId => !Number.isInteger(eventId) || eventId < 1) || new Set(input.futureEventIds).size !== input.futureEventIds.length) {
    return { status: "unavailable", reason: "Future event IDs must be unique positive integers." };
  }
  const scenarioReason = decisionScenarioCountUnavailableReason(input.scenarioCount);
  if (scenarioReason) return { status: "unavailable", reason: scenarioReason };
  if (!Number.isFinite(input.transfer.hitCost)) return { status: "unavailable", reason: "Candidate additional hit cost must be finite." };
  const outgoingMatches = input.squad.filter(player => player.id === input.transfer.out.id);
  if (outgoingMatches.length !== 1) return { status: "unavailable", reason: `Outgoing player ${input.transfer.out.id} must exist exactly once in the squad.` };
  if (input.squad.some(player => player.id === input.transfer.incoming.id)) return { status: "unavailable", reason: "Incoming player is already owned." };
  if (input.transfer.out.positionId !== input.transfer.incoming.positionId || input.transfer.out.positionShort !== input.transfer.incoming.positionShort) {
    return { status: "unavailable", reason: "Outgoing and incoming player positions must match." };
  }
  const swappedSquad = input.squad.map(player => player.id === input.transfer.out.id ? input.transfer.incoming : player);
  const baselineEvaluation = input.evaluate([...input.squad]);
  const candidateEvaluation = input.evaluate(swappedSquad);
  const baselineEvents = baselineEvaluation.weeks.map(week => week.eventId);
  const candidateEvents = candidateEvaluation.weeks.map(week => week.eventId);
  const matchesHorizon = (eventIds: readonly number[]) => eventIds.length === input.futureEventIds.length && eventIds.every((eventId, index) => eventId === input.futureEventIds[index]);
  if (!matchesHorizon(baselineEvents) || !matchesHorizon(candidateEvents)) {
    return { status: "unavailable", reason: "Baseline and candidate evaluations do not cover the explicit future event horizon." };
  }
  const baseline = freezeDecisionPlan({ id: "baseline", weeks: baselineEvaluation.weeks.map(toDecisionWeek) });
  const candidate = freezeDecisionPlan({ id: "candidate", weeks: candidateEvaluation.weeks.map(toDecisionWeek) });
  const firstEventId = input.futureEventIds[0];
  const players = new Map<number, FplPlayer>();
  for (const evaluation of [baselineEvaluation, candidateEvaluation]) for (const week of evaluation.weeks) for (const player of [...week.xi, ...week.bench]) players.set(player.id, player);
  const playerEventModels = baselineEvaluation.weeks.flatMap(week =>
    [...players.values()].map(player => buildPlayerEventOutcomeModel(player, week.eventId, input.fixtures, firstEventId)),
  );
  return analyzeDecisionConfidence({
    baseline,
    candidate,
    playerEventModels,
    candidateAdditionalHitCost: input.transfer.hitCost,
    scenarioCount: input.scenarioCount ?? DEFAULT_SCENARIO_COUNT,
  });
}
