import type { DecisionConfidenceInput, DecisionConfidenceResult, DecisionConfidenceUnavailable } from "./decision-confidence";
import { analyzeDecisionConfidence, analyzePreparedDecisionContext, prepareDecisionScenarioContext } from "./decision-confidence";
import type { TransferBreakEvenSensitivityResult } from "./transfer-sensitivity";
import { analyzeTransferBreakEvenSensitivity } from "./transfer-sensitivity";

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

export type TransferDecisionConfidenceWorkerRequest = {
  type: "analyze-transfer";
  requestId: number;
  analysisKey: string;
  analysis: DecisionConfidenceInput | DecisionConfidenceUnavailable;
  incomingPlayerId: number;
};

export type TransferDecisionConfidenceWorkerResponse =
  | { type: "transfer-main-result"; requestId: number; analysisKey: string; result: DecisionConfidenceResult; simulationMs: number }
  | { type: "transfer-main-error"; requestId: number; analysisKey: string; reason: string }
  | { type: "transfer-sensitivity-result"; requestId: number; analysisKey: string; result: TransferBreakEvenSensitivityResult; sensitivityMs: number }
  | { type: "transfer-sensitivity-error"; requestId: number; analysisKey: string; reason: string; sensitivityMs?: number };

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

/** Streams main analysis first, then sensitivity from the same prepared 1,024-scenario context. */
export function executeTransferDecisionConfidenceWorkerRequest(
  request: TransferDecisionConfidenceWorkerRequest,
  emit: (response: TransferDecisionConfidenceWorkerResponse) => void,
  now: () => number = () => performance.now(),
  analyzeSensitivity: typeof analyzeTransferBreakEvenSensitivity = analyzeTransferBreakEvenSensitivity,
): void {
  const common = { requestId: request.requestId, analysisKey: request.analysisKey };
  if ("status" in request.analysis) {
    emit({ type: "transfer-main-result", ...common, result: request.analysis, simulationMs: 0 });
    emit({ type: "transfer-sensitivity-result", ...common, result: request.analysis, sensitivityMs: 0 });
    return;
  }
  let context: ReturnType<typeof prepareDecisionScenarioContext>;
  const mainStarted = now();
  try {
    context = prepareDecisionScenarioContext(request.analysis);
    const main = context.status === "prepared" ? analyzePreparedDecisionContext(context.context) : context;
    emit({ type: "transfer-main-result", ...common, result: main, simulationMs: now() - mainStarted });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Decision Confidence calculation failed unexpectedly.";
    emit({ type: "transfer-main-error", ...common, reason });
    emit({ type: "transfer-sensitivity-error", ...common, reason: "Sensitivity could not run because the main scenario calculation failed." });
    return;
  }
  if (context.status !== "prepared") {
    emit({ type: "transfer-sensitivity-result", ...common, result: context, sensitivityMs: 0 });
    return;
  }
  const sensitivityStarted = now();
  try {
    const result = analyzeSensitivity({ context: context.context, incomingPlayerId: request.incomingPlayerId });
    emit({ type: "transfer-sensitivity-result", ...common, result, sensitivityMs: now() - sensitivityStarted });
  } catch (error) {
    emit({
      type: "transfer-sensitivity-error",
      ...common,
      reason: error instanceof Error ? error.message : "Break-even sensitivity failed unexpectedly.",
      sensitivityMs: now() - sensitivityStarted,
    });
  }
}
