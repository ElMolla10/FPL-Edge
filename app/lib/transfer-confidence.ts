import type { FplFixture, FplPlayer } from "./fpl";
import type { SquadEvaluation } from "./optimizer";
import type { Transfer } from "./transfers";
import { DecisionConfidenceResult, decisionScenarioCountUnavailableReason } from "./decision-confidence";
import { DEFAULT_DECISION_SCENARIO_COUNT, analyzeSquadDecisionConfidence } from "./squad-confidence";

// Canonical analysis size. Interactive callers move this work off the render thread; they do not
// reduce scenario count to conceal latency.
const DEFAULT_SCENARIO_COUNT = DEFAULT_DECISION_SCENARIO_COUNT;

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
  return analyzeSquadDecisionConfidence({
    fixtures: input.fixtures,
    futureEventIds: input.futureEventIds,
    dataUpdatedAt: "",
    baselineSquad: input.squad,
    candidateSquad: swappedSquad,
    baselineEvaluation,
    candidateEvaluation,
    candidateAdditionalHitCost: input.transfer.hitCost,
    scenarioCount: input.scenarioCount ?? DEFAULT_SCENARIO_COUNT,
  });
}
