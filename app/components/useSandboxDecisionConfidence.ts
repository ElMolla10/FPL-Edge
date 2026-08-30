"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FplData } from "../lib/fpl";
import type { SquadEvaluation } from "../lib/optimizer";
import {
  DecisionConfidenceWorkerRequest,
  DecisionConfidenceWorkerResponse,
  SandboxDecisionConfidenceState,
  applyDecisionConfidenceWorkerResponse,
  initialDecisionConfidenceState,
} from "../lib/decision-confidence-worker";
import { deriveSandboxConfidenceComparisons } from "../lib/sandbox-confidence";
import { PlayerEventModelCache, prepareSquadDecisionConfidence } from "../lib/squad-confidence";
import type { SandboxComparisonResult, SandboxState } from "../lib/squad-comparison";
import { sandboxEconomics } from "../lib/squad-comparison";

type HookInput = {
  data: FplData;
  futureEventIds: readonly number[];
  sandbox: SandboxState;
  comparison: SandboxComparisonResult;
  freeTransfers: number;
  settingsKey: string;
};

type KeyedState = { key: string; value: SandboxDecisionConfidenceState };

const planKey = (evaluation: SquadEvaluation) => evaluation.weeks.map(week =>
  `${week.eventId}:${week.xi.map(player => player.id).join(",")}:${week.bench.map(player => player.id).join(",")}:${week.captain.id}:${week.vice.id}`,
).join("|");

const limitEvaluation = (evaluation: SquadEvaluation, count: number): SquadEvaluation => ({
  ...evaluation,
  weeks: evaluation.weeks.slice(0, count),
});

export function useSandboxDecisionConfidence(input: HookInput): SandboxDecisionConfidenceState {
  const cacheRef = useRef(new PlayerEventModelCache());
  const requestCounter = useRef(0);
  const requestKey = useMemo(() => {
    const economics = sandboxEconomics(input.comparison, input.freeTransfers);
    return [
      input.data.updatedAt,
      input.settingsKey,
      input.futureEventIds.join(","),
      input.sandbox.history.length,
      input.sandbox.currentSquad.map(player => player.id).join(","),
      economics.incrementalHitChange,
      economics.cumulativeHitCost,
      planKey(input.comparison.latest.beforeEvaluation),
      planKey(input.comparison.latest.afterEvaluation),
      planKey(input.comparison.cumulative.beforeEvaluation),
    ].join("\0");
  }, [input]);
  const [stored, setStored] = useState<KeyedState>(() => ({ key: requestKey, value: initialDecisionConfidenceState(0) }));

  useEffect(() => {
    const requestId = ++requestCounter.current;
    const pending = initialDecisionConfidenceState(requestId);
    setStored({ key: requestKey, value: pending });
    const economics = sandboxEconomics(input.comparison, input.freeTransfers);
    const comparisons = deriveSandboxConfidenceComparisons(input.sandbox, economics);
    if (!comparisons) return;
    const eventIds = input.futureEventIds.slice(0, 5);
    const preparationStarted = performance.now();
    let latestPrepared: ReturnType<typeof prepareSquadDecisionConfidence>;
    let cumulativePrepared: ReturnType<typeof prepareSquadDecisionConfidence>;
    try {
      latestPrepared = prepareSquadDecisionConfidence({
        fixtures: input.data.fixtures,
        futureEventIds: eventIds,
        dataUpdatedAt: input.data.updatedAt,
        ...comparisons.latest,
        baselineEvaluation: limitEvaluation(input.comparison.latest.beforeEvaluation, eventIds.length),
        candidateEvaluation: limitEvaluation(input.comparison.latest.afterEvaluation, eventIds.length),
      }, cacheRef.current);
      cumulativePrepared = prepareSquadDecisionConfidence({
        fixtures: input.data.fixtures,
        futureEventIds: eventIds,
        dataUpdatedAt: input.data.updatedAt,
        ...comparisons.cumulative,
        baselineEvaluation: limitEvaluation(input.comparison.cumulative.beforeEvaluation, eventIds.length),
        candidateEvaluation: limitEvaluation(input.comparison.cumulative.afterEvaluation, eventIds.length),
      }, cacheRef.current);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Decision Confidence model preparation failed unexpectedly.";
      const failure = { status: "error" as const, reason };
      setStored(current => current.key === requestKey ? { key: requestKey, value: { requestId, latest: failure, cumulative: failure } } : current);
      return;
    }
    const preparationMs = performance.now() - preparationStarted;
    if (typeof Worker === "undefined") {
      const reason = "Background calculation is unavailable in this browser.";
      setStored(current => current.key === requestKey ? { key: requestKey, value: { requestId, latest: { status: "error", reason }, cumulative: { status: "error", reason } } } : current);
      return;
    }
    const failUnexpectedly = (reason: string) => {
      const response: DecisionConfidenceWorkerResponse = { type: "error", requestId, reason };
      setStored(current => current.key !== requestKey ? current : {
        key: requestKey,
        value: applyDecisionConfidenceWorkerResponse(current.value, response, preparationMs),
      });
    };
    let worker: Worker;
    try {
      worker = new Worker(new URL("../workers/decision-confidence.worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      failUnexpectedly(error instanceof Error ? error.message : "The background Decision Confidence calculation could not start.");
      return;
    }
    const request: DecisionConfidenceWorkerRequest = {
      type: "analyze",
      requestId,
      latest: latestPrepared.status === "prepared" ? latestPrepared.analysis : latestPrepared,
      cumulative: cumulativePrepared.status === "prepared" ? cumulativePrepared.analysis : cumulativePrepared,
    };
    worker.onmessage = (event: MessageEvent<DecisionConfidenceWorkerResponse>) => {
      setStored(current => current.key !== requestKey ? current : {
        key: requestKey,
        value: applyDecisionConfidenceWorkerResponse(current.value, event.data, preparationMs),
      });
      worker.terminate();
    };
    worker.onerror = () => {
      failUnexpectedly("The background Decision Confidence calculation stopped unexpectedly.");
      worker.terminate();
    };
    try {
      worker.postMessage(request);
    } catch (error) {
      failUnexpectedly(error instanceof Error ? error.message : "The Decision Confidence request could not be sent to the background worker.");
      worker.terminate();
      return;
    }
    return () => worker.terminate();
  }, [requestKey]);

  return stored.key === requestKey ? stored.value : initialDecisionConfidenceState(requestCounter.current + 1);
}
