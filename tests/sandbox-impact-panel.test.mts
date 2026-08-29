import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SandboxImpactPanel, * as sandboxPanel from "../app/components/SandboxImpactPanel.tsx";
import { compareSquads } from "../app/lib/squad-comparison.ts";
import { SquadEvaluation } from "../app/lib/optimizer.ts";
import { Transfer } from "../app/lib/transfers.ts";

function evaluation(objective: number, overall: number): SquadEvaluation {
  const captain = { id: 1, name: "Captain" } as never;
  const scores = { projectedPoints: 70, captaincy: 70, fixtures: 70, minutesSecurity: 70, bench: 70, flexibility: 70, value: 70, risk: 70, overall };
  return {
    objective,
    weightedPoints: 50,
    fiveWeekPoints: 50,
    weeks: [{ eventId: 38, xi: [captain], bench: [], captain, vice: captain, formation: "3-5-2", points: 50, captainPoints: 10 }],
    flexibility: 70,
    benchUtility: 0,
    deadSlots: 0,
    riskPenalty: 0,
    bank: 1,
    scores,
    warnings: [],
    strategy: { formation: "3-5-2", premiums: [], captain: "Captain", budget: {}, benchSpend: 0, targets: [], risk: "Balanced" },
  };
}

test("impact panel displays scores.overall as team rating and labels objective separately", () => {
  const comparison = compareSquads([], [], evaluation(10, 82), evaluation(35, 82));
  const transfer = {
    out: { id: 1, name: "Bruno", price: 8.5 },
    incoming: { id: 2, name: "Palmer", price: 10.5 },
    expectedMinutesOut: 80,
    expectedMinutesIn: 80,
    startProbOut: .9,
    startProbIn: .9,
    qualityStatus: "watchlist",
    qualityScore: 60,
  } as Transfer;

  const html = renderToStaticMarkup(createElement(SandboxImpactPanel, {
    comparison: { latest: comparison, cumulative: comparison, sandboxActionCount: 1, requiredTransferCount: 1, previousRequiredTransferCount: 0 },
    latestTransfer: transfer,
    freeTransfers: 1,
    onUndo: () => {},
    onReset: () => {},
  }));

  assert.match(html, /Overall team rating/);
  assert.match(html, /82[^0-9]+82[^0-9]+\+0/);
  assert.match(html, /Risk-adjusted objective/);
  assert.doesNotMatch(html, /SQUAD RATING[^]*\+25/);
});

test("ValueTransition uses a supplied semantic state instead of inferring presentation from the raw delta", () => {
  assert.equal(typeof sandboxPanel.ValueTransition, "function", "ValueTransition must be directly testable");
  const html = renderToStaticMarkup(createElement(sandboxPanel.ValueTransition, { before: 4, after: 8, delta: 4, state: "negative" }));

  assert.match(html, /class="negative"/);
  assert.doesNotMatch(html, /class="positive"/);
});

test("impact panel distinguishes sandbox actions, required transfers and an avoided hit", () => {
  const comparison = compareSquads([], [], evaluation(10, 82), evaluation(10, 82));
  const transfer = {
    out: { id: 2, name: "Candidate B", price: 9 },
    incoming: { id: 1, name: "Baseline A", price: 8 },
    expectedMinutesOut: 80,
    expectedMinutesIn: 80,
    startProbOut: .9,
    startProbIn: .9,
    qualityStatus: "watchlist",
    qualityScore: 60,
  } as Transfer;

  const html = renderToStaticMarkup(createElement(SandboxImpactPanel, {
    comparison: { latest: comparison, cumulative: comparison, sandboxActionCount: 3, requiredTransferCount: 1, previousRequiredTransferCount: 2 },
    latestTransfer: transfer,
    freeTransfers: 1,
    onUndo: () => {},
    onReset: () => {},
  }));

  assert.match(html, /Sandbox transfers[^]*Required final transfers from baseline/);
  assert.match(html, /Sandbox actions[^]*Exploratory swaps in this session/);
  assert.match(html, /4 pts avoided/);
  assert.doesNotMatch(html, /4-point cost included/);
});

test("impact panel labels official FPL bank and selling prices and renders the derived sandbox bank", () => {
  const comparison = compareSquads([], [], evaluation(10, 82), evaluation(10, 82));
  const transfer = {
    out: { id: 1, name: "Baseline", price: 10 },
    incoming: { id: 2, name: "Incoming", price: 7 },
    expectedMinutesOut: 80,
    expectedMinutesIn: 80,
    startProbOut: .9,
    startProbIn: .9,
    qualityStatus: "watchlist",
    qualityScore: 60,
  } as Transfer;

  const html = renderToStaticMarkup(createElement(SandboxImpactPanel, {
    comparison: {
      latest: comparison,
      cumulative: comparison,
      sandboxActionCount: 1,
      requiredTransferCount: 1,
      previousRequiredTransferCount: 0,
      financial: {
        source: "official",
        latest: { before: 1.2, after: .2, delta: -1 },
        cumulative: { before: 1.2, after: .2, delta: -1 },
      },
    },
    latestTransfer: transfer,
    freeTransfers: 1,
    onUndo: () => {},
    onReset: () => {},
  }));

  assert.match(html, /Official FPL bank and selling prices/);
  assert.match(html, /£1\.2m[^]*£0\.2m/);
  assert.doesNotMatch(html, /Current-price assumption/);
});
