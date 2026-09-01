import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RankEstimatePanel from "../app/components/RankEstimatePanel.tsx";
import type { RankEstimateResult } from "../app/lib/rank-estimate-core.ts";

const available: RankEstimateResult = {
  status: "available",
  currentRank: 500_000,
  correctionShift: 150,
  estimatedRanks: [1, 250_000, 500_000, 750_000, 1_000_000],
  bestRank: 1,
  medianRank: 500_000,
  worstRank: 1_000_000,
  clampedAboveCount: 1,
  clampedBelowCount: 0,
  improve: { count: 2, rate: 0.4 },
  worsen: { count: 2, rate: 0.4 },
  unchanged: { count: 1, rate: 0.2 },
  assumptions: ["Based on a 29-point sample of the real official \"Overall\" league standings, sampled 2026-09-01T00:00:00.000Z."],
};

test("RankEstimatePanel renders nothing while the population curve is still loading (result === null)", () => {
  const html = renderToStaticMarkup(createElement(RankEstimatePanel, { title: "Test", result: null }));
  assert.equal(html, "");
});

test("RankEstimatePanel renders an honest unavailable state with the real reason, not silently omitted", () => {
  const html = renderToStaticMarkup(createElement(RankEstimatePanel, {
    title: "Estimated rank",
    result: { status: "unavailable", reason: "Connect your official FPL team to see a rank estimate." },
  }));
  assert.match(html, /Rank estimate unavailable/);
  assert.match(html, /Connect your official FPL team/);
  assert.match(html, /aria-live="polite"/);
});

test("RankEstimatePanel renders the current rank, the range, arrow-chance frequencies, and the growth-correction line", () => {
  const html = renderToStaticMarkup(createElement(RankEstimatePanel, { title: "Estimated rank", result: available }));
  assert.match(html, /current real rank[^]*500,000|500,000[^]*current real rank/);
  assert.match(html, /Best 10% of scenarios[^]*1\b/);
  assert.match(html, /Median scenario[^]*500,000/);
  assert.match(html, /Worst 10% of scenarios[^]*1,000,000/);
  assert.match(html, /Est\. rank improves[^]*40\.0%/);
  assert.match(html, /Est\. rank worsens[^]*40\.0%/);
  assert.match(html, /No estimated change[^]*20\.0%/);
  assert.match(html, /Adjusted by \+150 pts/);
  assert.match(html, /<details/);
  assert.match(html, /Assumptions and disclosure/);
});

test("RankEstimatePanel states no adjustment plainly when correctionShift is exactly zero", () => {
  const html = renderToStaticMarkup(createElement(RankEstimatePanel, {
    title: "Estimated rank",
    result: { ...available, correctionShift: 0 },
  }));
  assert.match(html, /No population-growth adjustment applied/);
  assert.doesNotMatch(html, /Adjusted by/);
});

test("RankEstimatePanel replaces a non-finite result with an honest failure state, never rendering NaN or Infinity", () => {
  const html = renderToStaticMarkup(createElement(RankEstimatePanel, {
    title: "Estimated rank",
    result: { ...available, medianRank: Number.NaN },
  }));
  assert.match(html, /Unexpected calculation failure/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test("RankEstimatePanel wording never claims a literal rank-arrow guarantee -- 'est.'/'estimated' qualifiers are present", () => {
  const html = renderToStaticMarkup(createElement(RankEstimatePanel, { title: "Estimated rank", result: available }));
  assert.doesNotMatch(html, /guaranteed|calibrated probability/i);
  assert.match(html, /Est\.|estimated/i);
});
