import type { DecisionConfidenceInput, DecisionConfidenceResult, DecisionConfidenceUnavailable } from "./decision-confidence";
import { analyzeDecisionConfidence } from "./decision-confidence";

export type DecisionConfidenceDisplayState =
  | { status: "pending" }
  | { status: "available"; result: Extract<DecisionConfidenceResult, { status: "available" }> }
  | { status: "unavailable"; reason: string }
  | { status: "error"; reason: string };

export type DecisionConfidenceWorkerRequest = {
  type: "analyze";
  requestId: number;
  latest: DecisionConfidenceInput | DecisionConfidenceUnavailable;
  cumulative: DecisionConfidenceInput | DecisionConfidenceUnavailable;
};

export type DecisionConfidenceWorkerResponse =
  | {
      type: "result";
      requestId: number;
      latest: DecisionConfidenceResult;
      cumulative: DecisionConfidenceResult;
      timings: { latestSimulationMs: number; cumulativeSimulationMs: number };
    }
  | { type: "error"; requestId: number; reason: string };

export type SandboxDecisionConfidenceState = {
  requestId: number;
  latest: DecisionConfidenceDisplayState;
  cumulative: DecisionConfidenceDisplayState;
  timings?: { preparationMs: number; latestSimulationMs: number; cumulativeSimulationMs: number };
};

export const initialDecisionConfidenceState = (requestId: number): SandboxDecisionConfidenceState => ({
  requestId,
  latest: { status: "pending" },
  cumulative: { status: "pending" },
});

export function executeDecisionConfidenceWorkerRequest(
  request: DecisionConfidenceWorkerRequest,
  now: () => number = () => performance.now(),
): DecisionConfidenceWorkerResponse {
  try {
    const analyze = (input: DecisionConfidenceInput | DecisionConfidenceUnavailable) =>
      "status" in input ? input : analyzeDecisionConfidence(input);
    const latestStarted = now();
    const latest = analyze(request.latest);
    const latestSimulationMs = now() - latestStarted;
    const cumulativeStarted = now();
    const cumulative = analyze(request.cumulative);
    const cumulativeSimulationMs = now() - cumulativeStarted;
    return { type: "result", requestId: request.requestId, latest, cumulative, timings: { latestSimulationMs, cumulativeSimulationMs } };
  } catch (error) {
    return { type: "error", requestId: request.requestId, reason: error instanceof Error ? error.message : "Decision Confidence calculation failed unexpectedly." };
  }
}

export function applyDecisionConfidenceWorkerResponse(
  state: SandboxDecisionConfidenceState,
  response: DecisionConfidenceWorkerResponse,
  preparationMs = state.timings?.preparationMs ?? 0,
): SandboxDecisionConfidenceState {
  if (response.requestId !== state.requestId) return state;
  if (response.type === "error") {
    const failure = { status: "error" as const, reason: response.reason };
    return { ...state, latest: failure, cumulative: failure };
  }
  const displayState = (result: DecisionConfidenceResult): DecisionConfidenceDisplayState =>
    result.status === "available" ? { status: "available", result } : result;
  return {
    requestId: state.requestId,
    latest: displayState(response.latest),
    cumulative: displayState(response.cumulative),
    timings: { preparationMs, ...response.timings },
  };
}
