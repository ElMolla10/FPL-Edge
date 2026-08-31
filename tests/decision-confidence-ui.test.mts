import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DecisionConfidencePanel from "../app/components/DecisionConfidencePanel.tsx";
import {
  applyDecisionConfidenceWorkerResponse,
  executeDecisionConfidenceWorkerRequest,
  initialDecisionConfidenceState,
} from "../app/lib/decision-confidence-worker.ts";
import { DecisionConfidenceAvailable, DecisionConfidenceInput, freezeDecisionPlan } from "../app/lib/decision-confidence.ts";
import { FplPlayer } from "../app/lib/fpl.ts";

const available: DecisionConfidenceAvailable = {
  status: "available", scenarioCount: 1024, availableGameweeks: 5,
  frequencies: { gain: { count: 614, rate: 614 / 1024 }, tie: { count: 103, rate: 103 / 1024 }, loss: { count: 307, rate: 307 / 1024 } },
  expectedDelta: 2.25, p10: -7, p50: 2, p90: 12, preferred: "candidate",
  preferredAlternativeScenarioWinRate: 614 / 1024, label: "High-risk",
  assumptions: ["Modeled scenario frequencies are not calibrated probabilities.", "Captaincy is frozen."],
};

test("DecisionConfidencePanel renders pending, unavailable, and unexpected-error states accessibly", () => {
  const common = { title: "Latest transfer confidence", candidateLabel: "Make transfer", baselineLabel: "Keep previous squad", metricDirection: "Current sandbox squad minus previous squad", metricLabel: "latest sandbox delta" };
  const pending = renderToStaticMarkup(createElement(DecisionConfidencePanel, { ...common, state: { status: "pending" } }));
  assert.match(pending, /aria-live="polite"/);
  assert.match(pending, /Calculating 1,024 modeled scenarios/);

  const unavailable = renderToStaticMarkup(createElement(DecisionConfidencePanel, { ...common, state: { status: "unavailable", reason: "No future events are available." } }));
  assert.match(unavailable, /Decision Confidence unavailable/);
  assert.match(unavailable, /No future events are available/);

  const failed = renderToStaticMarkup(createElement(DecisionConfidencePanel, { ...common, state: { status: "error", reason: "Worker stopped" } }));
  assert.match(failed, /Unexpected calculation failure/);
  assert.match(failed, /Worker stopped/);
});

test("DecisionConfidencePanel renders all available metrics with qualified wording and finite values", () => {
  const html = renderToStaticMarkup(createElement(DecisionConfidencePanel, {
    title: "Latest transfer confidence", candidateLabel: "Make transfer", baselineLabel: "Keep previous squad",
    metricDirection: "Transfer minus current squad", metricLabel: "transfer delta",
    state: { status: "available", result: available },
  }));

  assert.match(html, /Preferred decision[^]*Make transfer/);
  assert.match(html, /High-risk/);
  assert.match(html, /Modeled scenario win rate[^]*60\.0%/);
  assert.match(html, /Gain[^]*60\.0%[^]*Tie[^]*10\.1%[^]*Loss[^]*30\.0%/);
  assert.match(html, /Signed metrics[^]*Transfer minus current squad/);
  assert.match(html, /Expected transfer delta after hit cost[^]*\+2\.3/);
  assert.match(html, /P10 transfer delta[^]*−7\.0[^]*P50 transfer delta[^]*\+2\.0[^]*P90 transfer delta[^]*\+12\.0/);
  assert.match(html, /1,024 modeled scenarios[^]*5 available gameweeks/);
  assert.match(html, /<details/);
  assert.match(html, /Assumptions and disclosure/);
  assert.doesNotMatch(html, /guaranteed chance|accuracy|\bprobability\b/i);
});

test("DecisionConfidencePanel replaces non-finite engine output with an honest failure state", () => {
  const html = renderToStaticMarkup(createElement(DecisionConfidencePanel, {
    title: "Cumulative sandbox confidence", candidateLabel: "Make transfers", baselineLabel: "Keep baseline squad",
    metricDirection: "Current sandbox squad minus original baseline", metricLabel: "cumulative sandbox delta",
    state: { status: "available", result: { ...available, p50: Number.NaN } },
  }));
  assert.match(html, /Unexpected calculation failure/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test("DecisionConfidencePanel uses previous/baseline squad and tie wording for non-candidate preferences", () => {
  const latest = renderToStaticMarkup(createElement(DecisionConfidencePanel, {
    title: "Latest transfer confidence", candidateLabel: "Make transfer", baselineLabel: "Keep previous squad",
    metricDirection: "Transfer minus current squad", metricLabel: "transfer delta",
    state: { status: "available", result: { ...available, preferred: "baseline", expectedDelta: -1, preferredAlternativeScenarioWinRate: .55 } },
  }));
  assert.match(latest, /Preferred decision[^]*Keep previous squad/);
  assert.match(latest, /Transfer minus current squad[^]*Expected transfer delta after hit cost[^]*−1\.0/);

  const cumulativeTie = renderToStaticMarkup(createElement(DecisionConfidencePanel, {
    title: "Cumulative sandbox confidence", candidateLabel: "Make transfers", baselineLabel: "Keep baseline squad",
    metricDirection: "Current sandbox squad minus original baseline", metricLabel: "cumulative sandbox delta",
    state: { status: "available", result: { ...available, preferred: "tie", expectedDelta: 0, preferredAlternativeScenarioWinRate: null } },
  }));
  assert.match(cumulativeTie, /Preferred decision[^]*Tie/);
  assert.match(cumulativeTie, /Modeled scenario win rate[^]*Not applicable for a tie/);
});

function player(): FplPlayer {
  return { id: 1, name: "P1", positionShort: "GKP", positionId: 1, eventPoints: 0, eventMinutes: 0 } as FplPlayer;
}

function decisionInput(): DecisionConfidenceInput {
  const p = player();
  const plan = freezeDecisionPlan({ id: "plan", weeks: [{ eventId: 1, xi: [p], bench: [], captain: p, vice: p, captainMultiplier: 2 }] });
  return {
    baseline: plan, candidate: plan, candidateAdditionalHitCost: 0, scenarioCount: 8,
    playerEventModels: [{ status: "available", player: p, eventId: 1, fixtures: [], audit: {
      targetExpectedPoints: 0, rawModeledMean: 0, reconciledModeledMean: 0, reconciliationGap: 0, tolerance: 0,
      sampledMeanTolerance: .2, components: { appearancePoints: 0, goalPoints: 0, assistPoints: 0, cleanSheetPoints: 0,
        bonusPoints: 0, defensiveContributionPoints: 0, continuousSavePoints: 0, discreteSavePoints: 0, penaltySavePoints: 0 },
      assumptions: [],
    } }],
  };
}

test("worker request and response survive structured cloning and remain deterministic", () => {
  const request = { type: "analyze" as const, requestId: 7, latest: decisionInput(), cumulative: decisionInput() };
  const cloned = structuredClone(request);
  const first = executeDecisionConfidenceWorkerRequest(cloned, () => 10);
  const second = executeDecisionConfidenceWorkerRequest(structuredClone(request), () => 10);
  assert.deepEqual(first, second);
  assert.equal(structuredClone(first).requestId, 7);
  assert.equal(first.type, "result");
  if (first.type === "result") {
    assert.equal(first.latest.status, "available");
    assert.equal(first.cumulative.status, "available");
  }
});

test("UI confidence state ignores a stale worker result but accepts the active result and errors", () => {
  const active = initialDecisionConfidenceState(2);
  const stale = applyDecisionConfidenceWorkerResponse(active, { type: "result", requestId: 1, latest: available, cumulative: available, timings: { latestSimulationMs: 1, cumulativeSimulationMs: 1 } });
  assert.deepEqual(stale, active);

  const completed = applyDecisionConfidenceWorkerResponse(active, { type: "result", requestId: 2, latest: available, cumulative: available, timings: { latestSimulationMs: 1, cumulativeSimulationMs: 2 } });
  assert.equal(completed.latest.status, "available");
  assert.equal(completed.cumulative.status, "available");

  const failed = applyDecisionConfidenceWorkerResponse(initialDecisionConfidenceState(3), { type: "error", requestId: 3, reason: "simulation exploded" });
  assert.deepEqual(failed.latest, { status: "error", reason: "simulation exploded" });
  assert.deepEqual(failed.cumulative, { status: "error", reason: "simulation exploded" });
});
