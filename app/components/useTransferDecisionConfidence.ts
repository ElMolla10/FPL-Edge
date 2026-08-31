"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FplData, FplPlayer } from "../lib/fpl";
import type { createOptimizer } from "../lib/optimizer";
import type { Transfer } from "../lib/transfers";
import type {
  TransferDecisionConfidenceWorkerRequest,
  TransferDecisionConfidenceWorkerResponse,
} from "../lib/decision-confidence-worker";
import { PlayerEventModelCache } from "../lib/squad-confidence";
import { prepareTransferDecisionConfidence } from "../lib/transfer-confidence";
import {
  MAX_TRANSFER_ANALYSIS_RESULTS,
  applyTransferAnalysisResponse,
  beginTransferAnalysis,
  createTransferWorkerPhaseTracker,
  immutableTransferAnalysisEntry,
  initialTransferAnalysisState,
  retainTransferAnalysisResults,
  supersedeTransferAnalysis,
  transferDecisionAnalysisKey,
  type TransferAnalysisEntry,
  type TransferAnalysisState,
} from "../lib/transfer-decision-ui";

type Optimizer = ReturnType<typeof createOptimizer>;

type HookInput = {
  data: FplData;
  squad: readonly FplPlayer[];
  optimizer: Optimizer;
  primary: Transfer | null;
  freeTransfers: number;
  selectedRoute: string;
};

export type TransferDecisionConfidenceController = {
  state: TransferAnalysisState;
  primaryKey: string | null;
  keyFor: (transfer: Transfer) => string;
  analyzeAlternative: (transfer: Transfer) => void;
  retryPrimary: () => void;
};

export function useTransferDecisionConfidence(input: HookInput): TransferDecisionConfidenceController {
  const modelCacheRef = useRef(new PlayerEventModelCache());
  const resultCacheRef = useRef(new Map<string, TransferAnalysisEntry>());
  const workerRef = useRef<Worker | null>(null);
  const requestCounter = useRef(0);
  const primaryKeyRef = useRef<string | null>(null);
  const displayedAlternativeKeyRef = useRef<string | null>(null);
  const [state, setState] = useState<TransferAnalysisState>(initialTransferAnalysisState);

  const sharedKey = useMemo(() => ({
    dataUpdatedAt: input.data.updatedAt,
    squadPlayerIds: input.squad.map(player => player.id),
    freeTransfers: input.freeTransfers,
    selectedRoute: input.selectedRoute,
    optimizerEventIds: input.optimizer.eventIds.slice(0, 5),
  }), [input.data.updatedAt, input.squad, input.freeTransfers, input.selectedRoute, input.optimizer.eventIds]);

  const keyFor = useCallback((transfer: Transfer) => transferDecisionAnalysisKey({
    ...sharedKey,
    transferKey: `${transfer.out.id}-${transfer.incoming.id}`,
    hitCost: transfer.hitCost,
  }), [sharedKey]);
  const primaryKey = input.primary ? keyFor(input.primary) : null;
  primaryKeyRef.current = primaryKey;

  const retainedKeys = () => [primaryKeyRef.current, displayedAlternativeKeyRef.current];

  const storeCompleted = (analysisKey: string, entry: TransferAnalysisEntry) => {
    const cache = resultCacheRef.current;
    if (cache.has(analysisKey)) cache.delete(analysisKey);
    cache.set(analysisKey, immutableTransferAnalysisEntry(entry));
    if (cache.size > MAX_TRANSFER_ANALYSIS_RESULTS) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  };

  const applyResponse = useCallback((response: TransferDecisionConfidenceWorkerResponse) => {
    setState(current => {
      const next = applyTransferAnalysisResponse(current, response, retainedKeys());
      if (next !== current && response.type === "transfer-sensitivity-result") {
        const entry = next.results[response.analysisKey];
        if (entry) storeCompleted(response.analysisKey, entry);
      }
      return next;
    });
  }, []);

  const start = useCallback((transfer: Transfer, analysisKey: string, preserveCompletedMain = false) => {
    const cached = preserveCompletedMain ? undefined : resultCacheRef.current.get(analysisKey);
    if (cached) {
      workerRef.current?.terminate();
      workerRef.current = null;
      requestCounter.current++;
      setState(current => {
        const base = supersedeTransferAnalysis(current, retainedKeys());
        return retainTransferAnalysisResults({ ...base, results: { ...base.results, [analysisKey]: cached } }, retainedKeys());
      });
      return;
    }
    workerRef.current?.terminate();
    workerRef.current = null;
    const requestId = ++requestCounter.current;
    const preparationStarted = performance.now();
    let prepared: ReturnType<typeof prepareTransferDecisionConfidence>;
    try {
      prepared = prepareTransferDecisionConfidence({
        fixtures: input.data.fixtures,
        futureEventIds: input.optimizer.eventIds.slice(0, 5),
        dataUpdatedAt: input.data.updatedAt,
        squad: input.squad,
        transfer,
        evaluate: input.optimizer.evaluate,
        scenarioCount: 1024,
      }, modelCacheRef.current);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Decision Confidence model preparation failed unexpectedly.";
      setState(current => {
        let failed = beginTransferAnalysis(
          supersedeTransferAnalysis(current, retainedKeys()),
          analysisKey,
          requestId,
          performance.now() - preparationStarted,
          { preserveCompletedMain, retainedKeys: retainedKeys() },
        );
        failed = applyTransferAnalysisResponse(failed, { type: "transfer-main-error", requestId, analysisKey, reason }, retainedKeys());
        return applyTransferAnalysisResponse(failed, { type: "transfer-sensitivity-error", requestId, analysisKey, reason: "Sensitivity could not run because model preparation failed." }, retainedKeys());
      });
      return;
    }
    const preparationMs = performance.now() - preparationStarted;
    setState(current => {
      return beginTransferAnalysis(
        supersedeTransferAnalysis(current, retainedKeys()),
        analysisKey,
        requestId,
        preparationMs,
        { preserveCompletedMain, retainedKeys: retainedKeys() },
      );
    });
    if (typeof Worker === "undefined") {
      applyResponse({ type: "transfer-main-error", requestId, analysisKey, reason: "Background calculation is unavailable in this browser." });
      applyResponse({ type: "transfer-sensitivity-error", requestId, analysisKey, reason: "Break-even sensitivity requires the background calculation worker." });
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(new URL("../workers/decision-confidence.worker.ts", import.meta.url), { type: "module" });
      workerRef.current = worker;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "The background Decision Confidence calculation could not start.";
      applyResponse({ type: "transfer-main-error", requestId, analysisKey, reason });
      applyResponse({ type: "transfer-sensitivity-error", requestId, analysisKey, reason: "Break-even sensitivity could not start." });
      return;
    }
    const phase = createTransferWorkerPhaseTracker();
    worker.onmessage = (event: MessageEvent<TransferDecisionConfidenceWorkerResponse>) => {
      phase.observe(event.data);
      applyResponse(event.data);
      if (event.data.type === "transfer-sensitivity-result" || event.data.type === "transfer-sensitivity-error") {
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
      }
    };
    worker.onerror = () => {
      phase.failureResponses(requestId, analysisKey).forEach(applyResponse);
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
    const request: TransferDecisionConfidenceWorkerRequest = {
      type: "analyze-transfer",
      requestId,
      analysisKey,
      analysis: prepared.status === "prepared" ? prepared.analysis : prepared,
      incomingPlayerId: transfer.incoming.id,
    };
    try {
      worker.postMessage(request);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "The Decision Confidence request could not be serialized for the background worker.";
      applyResponse({ type: "transfer-main-error", requestId, analysisKey, reason });
      applyResponse({ type: "transfer-sensitivity-error", requestId, analysisKey, reason: "Break-even sensitivity could not be serialized." });
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    }
  }, [applyResponse, input.data.fixtures, input.data.updatedAt, input.optimizer, input.squad]);

  useEffect(() => {
    if (input.primary && primaryKey) start(input.primary, primaryKey);
    else {
      workerRef.current?.terminate();
      workerRef.current = null;
      requestCounter.current++;
    }
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [primaryKey]);

  const analyzeAlternative = useCallback((transfer: Transfer) => {
    const analysisKey = keyFor(transfer);
    displayedAlternativeKeyRef.current = analysisKey;
    start(transfer, analysisKey);
  }, [keyFor, start]);
  const retryPrimary = useCallback(() => {
    if (!input.primary || !primaryKey || workerRef.current) return;
    start(input.primary, primaryKey, true);
  }, [input.primary, primaryKey, start]);
  return { state, primaryKey, keyFor, analyzeAlternative, retryPrimary };
}
