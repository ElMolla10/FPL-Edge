import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TransferSensitivityPanel from "../app/components/TransferSensitivityPanel.tsx";

const assumptions = ["Each factor varies independently while the plan stays frozen."];
const available = {
  status: "available" as const,
  direction: "reduction" as const,
  factorOneResult: {
    status: "available" as const, scenarioCount: 1024, availableGameweeks: 5, horizonTier: "near-term" as const,
    frequencies: { gain: { count: 600, rate: 600 / 1024 }, tie: { count: 24, rate: 24 / 1024 }, loss: { count: 400, rate: 400 / 1024 } },
    expectedDelta: 1, p10: -5, p50: 1, p90: 8, preferred: "candidate" as const,
    preferredAlternativeScenarioWinRate: 600 / 1024, label: "High-risk" as const, assumptions: [],
  },
  factors: [
    { status: "available" as const, factor: "expected-minutes" as const, direction: "below" as const, threshold: 66, message: "Break-even: the transfer turns negative if Palmer’s modeled expected minutes fall below 66 per fixture." },
    { status: "unavailable" as const, factor: "attacking-return-rate" as const, reason: "The valid range does not reverse the decision." },
  ],
  assumptions,
};

test("sensitivity panel renders pending, available, unavailable, and unexpected failures accessibly", () => {
  const pending = renderToStaticMarkup(createElement(TransferSensitivityPanel, { state: { status: "pending" } }));
  assert.match(pending, /aria-live="polite"/);
  assert.match(pending, /Calculating break-even sensitivity/);
  const success = renderToStaticMarkup(createElement(TransferSensitivityPanel, { state: { status: "available", result: available } }));
  assert.match(success, /Break-even sensitivity/);
  assert.match(success, /fall below 66 per fixture/);
  assert.match(success, /valid range does not reverse/);
  assert.match(success, /varied independently/);
  const unavailable = renderToStaticMarkup(createElement(TransferSensitivityPanel, { state: { status: "unavailable", reason: "A tied decision has no direction." } }));
  assert.match(unavailable, /Sensitivity unavailable[^]*tied decision/);
  const error = renderToStaticMarkup(createElement(TransferSensitivityPanel, { state: { status: "error", reason: "Worker failed" } }));
  assert.match(error, /Unexpected sensitivity failure[^]*Worker failed/);
});

test("sensitivity panel offers retries for interrupted and transient failures, but not deterministic unavailable results", () => {
  const retry = () => undefined;
  const interrupted = renderToStaticMarkup(createElement(TransferSensitivityPanel, {
    state: { status: "unavailable", reason: "Sensitivity was superseded.", retryable: true }, onRetry: retry,
  }));
  assert.match(interrupted, /Retry Decision Confidence and sensitivity/);
  const transient = renderToStaticMarkup(createElement(TransferSensitivityPanel, {
    state: { status: "error", reason: "Worker failed" }, onRetry: retry,
  }));
  assert.match(transient, /Retry Decision Confidence and sensitivity/);
  const deterministic = renderToStaticMarkup(createElement(TransferSensitivityPanel, {
    state: { status: "unavailable", reason: "No valid model reversal." }, onRetry: retry,
  }));
  assert.doesNotMatch(deterministic, /Retry Decision Confidence and sensitivity/);
  const busy = renderToStaticMarkup(createElement(TransferSensitivityPanel, {
    state: { status: "error", reason: "Worker failed" }, onRetry: retry, retryDisabled: true,
  }));
  assert.match(busy, /disabled=""/);
});

test("Transfers integration suppresses Decision Confidence for ROLL and never persists analysis results", () => {
  const coach = readFileSync(new URL("../app/components/CoachApp.tsx", import.meta.url), "utf8");
  const hook = readFileSync(new URL("../app/components/useTransferDecisionConfidence.ts", import.meta.url), "utf8");
  assert.match(coach, /!roll&&[^]*DecisionConfidencePanel/);
  assert.doesNotMatch(hook, /localStorage|sessionStorage|persist\(/);
  assert.match(hook, /new Map<string, TransferAnalysisEntry>/);
  assert.match(hook, /workerRef\.current\?\.terminate/);
  assert.match(hook, /retainTransferAnalysisResults/);
  assert.match(hook, /immutableTransferAnalysisEntry/);
  assert.match(hook, /const phase = createTransferWorkerPhaseTracker\(\)/);
  assert.match(hook, /worker\.onmessage[^]*phase\.observe\(event\.data\)[^]*applyResponse\(event\.data\)/);
  assert.doesNotMatch(hook, /stateRef/);
});

test("user-facing projection strength is called Projection evidence, not Model confidence", () => {
  const sources = [
    "../app/components/CoachApp.tsx",
    "../app/components/TransferBreakdown.tsx",
    "../app/lib/transfer-quality.ts",
  ].map(path => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
  assert.match(sources, /Projection evidence/);
  assert.doesNotMatch(sources, /Model confidence|model confidence|player-confidence|Route confidence|Confidence IN/);
});
