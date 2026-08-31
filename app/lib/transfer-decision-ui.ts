import type { DecisionConfidenceDisplayState, TransferDecisionConfidenceWorkerResponse } from "./decision-confidence-worker";
import type { TransferBreakEvenSensitivityResult } from "./transfer-sensitivity";

export type TransferSensitivityDisplayState =
  | { status: "pending" }
  | { status: "available"; result: Extract<TransferBreakEvenSensitivityResult, { status: "available" }> }
  | { status: "unavailable"; reason: string; retryable?: boolean }
  | { status: "error"; reason: string };

export type TransferAnalysisEntry = {
  requestId: number;
  main: DecisionConfidenceDisplayState;
  sensitivity: TransferSensitivityDisplayState;
  timings?: { preparationMs?: number; simulationMs?: number; sensitivityMs?: number };
};

export type TransferAnalysisState = {
  activeKey: string | null;
  activeRequestId: number | null;
  results: Record<string, TransferAnalysisEntry>;
};

export const initialTransferAnalysisState = (): TransferAnalysisState => ({ activeKey: null, activeRequestId: null, results: {} });

export const MAX_TRANSFER_ANALYSIS_RESULTS = 32;

type BeginTransferAnalysisOptions = {
  preserveCompletedMain?: boolean;
  retainedKeys?: readonly (string | null | undefined)[];
};

/** Keeps the active analysis plus preferred visible results, then retains the newest remaining entries. */
export function retainTransferAnalysisResults(
  state: TransferAnalysisState,
  retainedKeys: readonly (string | null | undefined)[] = [],
): TransferAnalysisState {
  const keys = Object.keys(state.results);
  if (keys.length <= MAX_TRANSFER_ANALYSIS_RESULTS) return state;
  const retained = new Set<string>();
  const protect = (key: string | null | undefined) => {
    if (key && state.results[key] && retained.size < MAX_TRANSFER_ANALYSIS_RESULTS) retained.add(key);
  };
  protect(state.activeKey);
  retainedKeys.forEach(protect);
  for (let index = keys.length - 1; index >= 0 && retained.size < MAX_TRANSFER_ANALYSIS_RESULTS; index--) {
    retained.add(keys[index]);
  }
  const results: Record<string, TransferAnalysisEntry> = {};
  keys.forEach(key => {
    if (retained.has(key)) results[key] = state.results[key];
  });
  return { ...state, results };
}

export function beginTransferAnalysis(
  state: TransferAnalysisState,
  analysisKey: string,
  requestId: number,
  preparationMs?: number,
  options: BeginTransferAnalysisOptions = {},
): TransferAnalysisState {
  const prior = state.results[analysisKey];
  const preserveMain = options.preserveCompletedMain && prior && (prior.main.status === "available" || prior.main.status === "unavailable");
  return retainTransferAnalysisResults({
    activeKey: analysisKey,
    activeRequestId: requestId,
    results: {
      ...state.results,
      [analysisKey]: {
        requestId,
        main: preserveMain ? prior.main : { status: "pending" },
        sensitivity: { status: "pending" },
        timings: preparationMs === undefined
          ? preserveMain ? prior.timings : undefined
          : { ...(preserveMain ? prior.timings : undefined), preparationMs },
      },
    },
  }, options.retainedKeys);
}

export function applyTransferAnalysisResponse(
  state: TransferAnalysisState,
  response: TransferDecisionConfidenceWorkerResponse,
  retainedKeys: readonly (string | null | undefined)[] = [],
): TransferAnalysisState {
  if (state.activeRequestId !== response.requestId || state.activeKey !== response.analysisKey) return state;
  const entry = state.results[response.analysisKey];
  if (!entry || entry.requestId !== response.requestId) return state;
  let nextEntry = entry;
  let complete = false;
  if (response.type === "transfer-main-result") {
    nextEntry = {
      ...entry,
      main: response.result.status === "available" ? { status: "available", result: response.result } : response.result,
      timings: { ...entry.timings, simulationMs: response.simulationMs },
    };
  } else if (response.type === "transfer-main-error") {
    nextEntry = { ...entry, main: { status: "error", reason: response.reason } };
  } else if (response.type === "transfer-sensitivity-result") {
    nextEntry = {
      ...entry,
      sensitivity: response.result.status === "available" ? { status: "available", result: response.result } : response.result,
      timings: { ...entry.timings, sensitivityMs: response.sensitivityMs },
    };
    complete = true;
  } else {
    nextEntry = {
      ...entry,
      sensitivity: { status: "error", reason: response.reason },
      timings: response.sensitivityMs === undefined ? entry.timings : { ...entry.timings, sensitivityMs: response.sensitivityMs },
    };
    complete = true;
  }
  return retainTransferAnalysisResults({
    activeKey: complete ? null : state.activeKey,
    activeRequestId: complete ? null : state.activeRequestId,
    results: { ...state.results, [response.analysisKey]: nextEntry },
  }, retainedKeys);
}

export function supersedeTransferAnalysis(
  state: TransferAnalysisState,
  retainedKeys: readonly (string | null | undefined)[] = [],
): TransferAnalysisState {
  if (!state.activeKey || state.activeRequestId === null) return retainTransferAnalysisResults(state, retainedKeys);
  const active = state.results[state.activeKey];
  if (!active) return retainTransferAnalysisResults({ ...state, activeKey: null, activeRequestId: null }, retainedKeys);
  return retainTransferAnalysisResults({
    ...state,
    activeKey: null,
    activeRequestId: null,
    results: {
      ...state.results,
      [state.activeKey]: {
        ...active,
        main: active.main.status === "pending"
          ? { status: "unavailable", reason: "This analysis was superseded by a newer transfer selection." }
          : active.main,
        sensitivity: active.sensitivity.status === "pending"
          ? { status: "unavailable", reason: "Sensitivity was superseded by a newer transfer selection.", retryable: true }
          : active.sensitivity,
      },
    },
  }, retainedKeys);
}

export function isTransferSensitivityRetryable(state: TransferSensitivityDisplayState): boolean {
  return state.status === "error" || (state.status === "unavailable" && state.retryable === true);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Cache snapshots cannot be mutated through React state or later worker responses. */
export function immutableTransferAnalysisEntry(entry: TransferAnalysisEntry): TransferAnalysisEntry {
  return deepFreeze(structuredClone(entry));
}

export function createTransferWorkerPhaseTracker() {
  let mainDelivered = false;
  return {
    observe(response: TransferDecisionConfidenceWorkerResponse): void {
      if (response.type === "transfer-main-result" || response.type === "transfer-main-error") mainDelivered = true;
    },
    failureResponses(requestId: number, analysisKey: string): TransferDecisionConfidenceWorkerResponse[] {
      if (mainDelivered) {
        return [{
          type: "transfer-sensitivity-error",
          requestId,
          analysisKey,
          reason: "The background sensitivity calculation stopped unexpectedly.",
        }];
      }
      return [
        {
          type: "transfer-main-error",
          requestId,
          analysisKey,
          reason: "The background Decision Confidence calculation stopped unexpectedly.",
        },
        {
          type: "transfer-sensitivity-error",
          requestId,
          analysisKey,
          reason: "Sensitivity could not run because the worker stopped.",
        },
      ];
    },
  };
}

export type TransferDecisionAnalysisKeyInput = {
  dataUpdatedAt: string;
  squadPlayerIds: readonly number[];
  freeTransfers: number;
  selectedRoute: string;
  optimizerEventIds: readonly number[];
  transferKey: string;
  hitCost: number;
};

export function transferDecisionAnalysisKey(input: TransferDecisionAnalysisKeyInput): string {
  return [
    input.dataUpdatedAt,
    input.squadPlayerIds.join(","),
    input.freeTransfers,
    input.selectedRoute,
    input.optimizerEventIds.join(","),
    input.transferKey,
    input.hitCost,
  ].join("\0");
}
