import assert from "node:assert/strict";
import test from "node:test";
import type { DecisionConfidenceInput } from "../app/lib/decision-confidence.ts";
import { freezeDecisionPlan } from "../app/lib/decision-confidence.ts";
import type { FplPlayer } from "../app/lib/fpl.ts";
import type { AvailablePlayerEventOutcomeModel } from "../app/lib/projection-distribution.ts";
import {
  executeTransferDecisionConfidenceWorkerRequest,
  type TransferDecisionConfidenceWorkerRequest,
  type TransferDecisionConfidenceWorkerResponse,
} from "../app/lib/decision-confidence-worker.ts";
import {
  MAX_TRANSFER_ANALYSIS_RESULTS,
  applyTransferAnalysisResponse,
  beginTransferAnalysis,
  createTransferWorkerPhaseTracker,
  immutableTransferAnalysisEntry,
  initialTransferAnalysisState,
  isTransferSensitivityRetryable,
  supersedeTransferAnalysis,
  transferDecisionAnalysisKey,
} from "../app/lib/transfer-decision-ui.ts";

const player = (id: number): FplPlayer => ({ id, name: `P${id}`, teamId: id, positionId: 3, positionShort: "MID", eventPoints: 0, eventMinutes: 0 } as FplPlayer);
const audit = {
  targetExpectedPoints: 0, rawModeledMean: 0, reconciledModeledMean: 0, reconciliationGap: 0, tolerance: 0, sampledMeanTolerance: .2,
  components: { appearancePoints: 0, goalPoints: 0, assistPoints: 0, cleanSheetPoints: 0, bonusPoints: 0,
    defensiveContributionPoints: 0, continuousSavePoints: 0, discreteSavePoints: 0, penaltySavePoints: 0 }, assumptions: [],
} as const;

function model(p: FplPlayer, points: number): AvailablePlayerEventOutcomeModel {
  const pmf = new Array(points + 1).fill(0); pmf[points] = 1;
  return {
    status: "available", player: p, eventId: 1,
    fixtures: [{ fixtureId: 101, teamId: p.teamId, appearanceProbability: 1, reached60Probability: 1,
      pointsWhenAppearedPmf: pmf, cleanSheetProbability: 0, cleanSheetPoints: 1, reconciliation: "none" }],
    audit,
    sensitivity: Object.freeze({ expectedMinutes: 60, attackingReturnRate: .5, fixtures: Object.freeze([Object.freeze({
      fixtureId: 101, conditionalExpectedGoals: .25, conditionalExpectedAssists: .25, confidence: 1,
      nonAttackingPointsWhenAppearedPmf: Object.freeze([1]), reconciliation: Object.freeze({ mode: "none" as const }),
    })]) }),
  };
}

function analysis(): DecisionConfidenceInput {
  const outgoing = player(1), incoming = player(2);
  const baseline = freezeDecisionPlan({ id: "baseline", weeks: [{ eventId: 1, xi: [outgoing], bench: [], captain: outgoing, vice: outgoing, captainMultiplier: 2 }] });
  const candidate = freezeDecisionPlan({ id: "candidate", weeks: [{ eventId: 1, xi: [incoming], bench: [], captain: incoming, vice: incoming, captainMultiplier: 2 }] });
  return { baseline, candidate, playerEventModels: [model(outgoing, 0), model(incoming, 3)], candidateAdditionalHitCost: 0, scenarioCount: 1024 };
}

const available = {
  status: "available" as const, scenarioCount: 1024, availableGameweeks: 1,
  frequencies: { gain: { count: 1024, rate: 1 }, tie: { count: 0, rate: 0 }, loss: { count: 0, rate: 0 } },
  expectedDelta: 3, p10: 3, p50: 3, p90: 3, preferred: "candidate" as const,
  preferredAlternativeScenarioWinRate: 1, label: "Robust" as const, assumptions: [],
};

test("transfer worker emits the completed main result before sensitivity and keeps it when sensitivity fails", () => {
  const request: TransferDecisionConfidenceWorkerRequest = { type: "analyze-transfer", requestId: 4, analysisKey: "primary", analysis: analysis(), incomingPlayerId: 2 };
  const responses: TransferDecisionConfidenceWorkerResponse[] = [];
  executeTransferDecisionConfidenceWorkerRequest(structuredClone(request), response => responses.push(structuredClone(response)), () => 10, () => { throw new Error("sensitivity exploded"); });
  assert.equal(responses.length, 2);
  assert.equal(responses[0].type, "transfer-main-result");
  assert.equal(responses[1].type, "transfer-sensitivity-error");
  if (responses[0].type === "transfer-main-result") assert.equal(responses[0].result.status, "available");
  if (responses[1].type === "transfer-sensitivity-error") assert.match(responses[1].reason, /sensitivity exploded/);
});

test("transfer worker request, immutable sensitivity metadata, and phased responses are structured-clone-safe and deterministic", () => {
  const request: TransferDecisionConfidenceWorkerRequest = { type: "analyze-transfer", requestId: 5, analysisKey: "primary", analysis: analysis(), incomingPlayerId: 2 };
  const run = () => {
    const responses: TransferDecisionConfidenceWorkerResponse[] = [];
    executeTransferDecisionConfidenceWorkerRequest(structuredClone(request), response => responses.push(structuredClone(response)), () => 10);
    return responses;
  };
  assert.deepEqual(run(), run());
});

test("starting an alternative preserves a completed primary and stale responses cannot overwrite either block", () => {
  let state = beginTransferAnalysis(initialTransferAnalysisState(), "primary", 1);
  state = applyTransferAnalysisResponse(state, { type: "transfer-main-result", requestId: 1, analysisKey: "primary", result: available, simulationMs: 20 });
  state = beginTransferAnalysis(state, "alternative", 2);
  assert.equal(state.results.primary.main.status, "available");
  assert.equal(state.results.alternative.main.status, "pending");
  const stale = applyTransferAnalysisResponse(state, { type: "transfer-main-error", requestId: 1, analysisKey: "primary", reason: "late failure" });
  assert.deepEqual(stale, state);
  assert.equal(stale.results.primary.main.status, "available");
});

test("analysis cache key invalidates for squad, data, free transfers, selected route, horizon, transfer, and hit changes", () => {
  const base = { dataUpdatedAt: "v1", squadPlayerIds: [1, 2, 3], freeTransfers: 1, selectedRoute: "moves", optimizerEventIds: [1, 2, 3, 4, 5], transferKey: "1-9", hitCost: 0 };
  const key = transferDecisionAnalysisKey(base);
  const variants = [
    { ...base, dataUpdatedAt: "v2" }, { ...base, squadPlayerIds: [1, 2, 4] }, { ...base, freeTransfers: 2 },
    { ...base, selectedRoute: "routes" }, { ...base, optimizerEventIds: [2, 3, 4, 5] }, { ...base, transferKey: "2-9" }, { ...base, hitCost: 4 },
  ];
  variants.forEach(variant => assert.notEqual(transferDecisionAnalysisKey(variant), key));
});

test("analysis state retains at most 32 results while protecting the primary, displayed alternative, and active analysis", () => {
  let state = initialTransferAnalysisState();
  const retainedKeys = ["primary", "displayed-alternative"];
  const complete = (key: string, requestId: number) => {
    state = beginTransferAnalysis(state, key, requestId, undefined, { retainedKeys });
    assert.ok(Object.keys(state.results).length <= MAX_TRANSFER_ANALYSIS_RESULTS);
    assert.ok(state.results[key], "the active analysis must never be evicted");
    state = applyTransferAnalysisResponse(state, { type: "transfer-main-result", requestId, analysisKey: key, result: available, simulationMs: 20 }, retainedKeys);
    state = applyTransferAnalysisResponse(state, {
      type: "transfer-sensitivity-result", requestId, analysisKey: key,
      result: { status: "unavailable", reason: "No reversal in the valid range." }, sensitivityMs: 10,
    }, retainedKeys);
  };
  complete("primary", 1);
  complete("displayed-alternative", 2);
  for (let index = 0; index < 40; index++) complete(`analysis-${index}`, index + 3);
  assert.ok(Object.keys(state.results).length <= MAX_TRANSFER_ANALYSIS_RESULTS);
  assert.ok(state.results.primary);
  assert.ok(state.results["displayed-alternative"]);
  assert.ok(state.results["analysis-39"]);
});

test("interrupted primary sensitivity remains retryable after the alternative completes and retry preserves its main result", () => {
  let state = beginTransferAnalysis(initialTransferAnalysisState(), "primary", 1);
  state = applyTransferAnalysisResponse(state, { type: "transfer-main-result", requestId: 1, analysisKey: "primary", result: available, simulationMs: 20 });
  state = supersedeTransferAnalysis(state, ["primary", "alternative"]);
  assert.equal(state.results.primary.main.status, "available");
  assert.deepEqual(state.results.primary.sensitivity, {
    status: "unavailable", reason: "Sensitivity was superseded by a newer transfer selection.", retryable: true,
  });

  state = beginTransferAnalysis(state, "alternative", 2, undefined, { retainedKeys: ["primary", "alternative"] });
  state = applyTransferAnalysisResponse(state, { type: "transfer-main-result", requestId: 2, analysisKey: "alternative", result: available, simulationMs: 20 }, ["primary", "alternative"]);
  state = applyTransferAnalysisResponse(state, {
    type: "transfer-sensitivity-result", requestId: 2, analysisKey: "alternative",
    result: { status: "unavailable", reason: "No reversal in the valid range." }, sensitivityMs: 10,
  }, ["primary", "alternative"]);
  assert.equal(state.activeKey, null);
  assert.equal(isTransferSensitivityRetryable(state.results.primary.sensitivity), true);

  state = beginTransferAnalysis(state, "primary", 3, undefined, { preserveCompletedMain: true, retainedKeys: ["primary", "alternative"] });
  assert.equal(state.results.primary.main.status, "available");
  assert.equal(state.results.primary.sensitivity.status, "pending");
  assert.equal(state.activeKey, "primary");
});

test("only transient sensitivity failures are retryable", () => {
  assert.equal(isTransferSensitivityRetryable({ status: "error", reason: "Worker failed" }), true);
  assert.equal(isTransferSensitivityRetryable({ status: "unavailable", reason: "Superseded", retryable: true }), true);
  assert.equal(isTransferSensitivityRetryable({ status: "unavailable", reason: "No valid model reversal." }), false);
  assert.equal(isTransferSensitivityRetryable({ status: "available", result: {
    status: "available", direction: "reduction", factorOneResult: available, factors: [], assumptions: [],
  } }), false);
});

test("a transient pre-main failure can be retried as a fresh pending analysis", () => {
  let state = beginTransferAnalysis(initialTransferAnalysisState(), "primary", 1);
  state = applyTransferAnalysisResponse(state, { type: "transfer-main-error", requestId: 1, analysisKey: "primary", reason: "Worker startup failed" });
  state = applyTransferAnalysisResponse(state, { type: "transfer-sensitivity-error", requestId: 1, analysisKey: "primary", reason: "Sensitivity could not start" });
  assert.equal(state.results.primary.main.status, "error");
  assert.equal(isTransferSensitivityRetryable(state.results.primary.sensitivity), true);
  state = beginTransferAnalysis(state, "primary", 2, undefined, { preserveCompletedMain: true });
  assert.equal(state.results.primary.main.status, "pending");
  assert.equal(state.results.primary.sensitivity.status, "pending");
  assert.equal(state.activeRequestId, 2);
});

test("worker-local phase tracking turns a main-message-then-error race into sensitivity-only failure", () => {
  const tracker = createTransferWorkerPhaseTracker();
  const mainResponse = { type: "transfer-main-result" as const, requestId: 9, analysisKey: "primary", result: available, simulationMs: 20 };
  let state = beginTransferAnalysis(initialTransferAnalysisState(), "primary", 9);
  tracker.observe(mainResponse);
  state = applyTransferAnalysisResponse(state, mainResponse);
  const failures = tracker.failureResponses(9, "primary");
  assert.deepEqual(failures, [{
    type: "transfer-sensitivity-error", requestId: 9, analysisKey: "primary",
    reason: "The background sensitivity calculation stopped unexpectedly.",
  }]);
  failures.forEach(response => { state = applyTransferAnalysisResponse(state, response); });
  assert.equal(state.results.primary.main.status, "available");
  assert.equal(state.results.primary.sensitivity.status, "error");
  const beforeMain = createTransferWorkerPhaseTracker().failureResponses(10, "alternative");
  assert.deepEqual(beforeMain.map(response => response.type), ["transfer-main-error", "transfer-sensitivity-error"]);
});

test("completed cache entries are deeply immutable snapshots", () => {
  const entry: import("../app/lib/transfer-decision-ui.ts").TransferAnalysisEntry = {
    requestId: 1,
    main: { status: "available", result: available },
    sensitivity: { status: "unavailable", reason: "No reversal." },
    timings: { simulationMs: 20 },
  };
  const cached = immutableTransferAnalysisEntry(entry);
  assert.notEqual(cached, entry);
  assert.equal(Object.isFrozen(cached), true);
  assert.equal(Object.isFrozen(cached.main), true);
  assert.equal(cached.main.status === "available" && Object.isFrozen(cached.main.result.frequencies), true);
  assert.throws(() => { (cached.timings as { simulationMs?: number }).simulationMs = 99; }, TypeError);
  assert.equal(cached.timings?.simulationMs, 20);
});
