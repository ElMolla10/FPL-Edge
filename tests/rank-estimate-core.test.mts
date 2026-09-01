import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateRankDistribution,
  estimateRankFromPoints,
} from "../app/lib/rank-estimate-core.ts";
import type { PercentileCurvePoint, PopulationPercentileResult } from "../app/lib/population-percentile-core.ts";

const curve: readonly PercentileCurvePoint[] = [
  { rank: 1, points: 200 },
  { rank: 100, points: 180 },
  { rank: 10_000, points: 150 },
  { rank: 1_000_000, points: 100 },
];
const TOTAL_PLAYERS = 10_000_000;

test("estimateRankFromPoints: exact matches at sampled points return that exact real rank", () => {
  assert.deepEqual(estimateRankFromPoints(curve, TOTAL_PLAYERS, 200), { rank: 1, clamped: "none" });
  assert.deepEqual(estimateRankFromPoints(curve, TOTAL_PLAYERS, 180), { rank: 100, clamped: "none" });
  assert.deepEqual(estimateRankFromPoints(curve, TOTAL_PLAYERS, 150), { rank: 10_000, clamped: "none" });
  assert.deepEqual(estimateRankFromPoints(curve, TOTAL_PLAYERS, 100), { rank: 1_000_000, clamped: "none" });
});

test("estimateRankFromPoints: linear interpolation at the exact midpoint of a bracket lands at the midpoint of both points and ranks", () => {
  // Bracket (rank 1, 200pts) - (rank 100, 180pts): midpoint points=190 -> midpoint rank=50.5
  const result = estimateRankFromPoints(curve, TOTAL_PLAYERS, 190);
  assert.equal(result.clamped, "none");
  assert.equal(result.rank, 50.5);
});

test("estimateRankFromPoints: interpolation is linear, not just monotonic -- verified at a non-midpoint fraction by hand", () => {
  // Bracket (rank 100, 180pts) - (rank 10000, 150pts), range 30 points / 9900 ranks.
  // At points=171 (9 of 30 = 30% of the way down from 180): t=(180-171)/30=0.3 -> rank=100+0.3*9900=3070
  const result = estimateRankFromPoints(curve, TOTAL_PLAYERS, 171);
  assert.equal(result.clamped, "none");
  assert.equal(result.rank, 3070);
});

test("estimateRankFromPoints: above the best sampled point clamps to rank 1, flagged, not extrapolated below 1", () => {
  const result = estimateRankFromPoints(curve, TOTAL_PLAYERS, 250);
  assert.deepEqual(result, { rank: 1, clamped: "above-range" });
});

test("estimateRankFromPoints: below the worst sampled point clamps to the real total population size, not the last sample's rank", () => {
  const result = estimateRankFromPoints(curve, TOTAL_PLAYERS, 10);
  assert.deepEqual(result, { rank: TOTAL_PLAYERS, clamped: "below-range" });
  assert.notEqual(result.rank, curve[curve.length - 1].rank, "must not silently reuse the last sample's rank as if it were the true bottom");
});

test("estimateRankFromPoints: a degenerate zero-width bracket (a real tie block between two samples) returns the midpoint, not a division-by-zero crash", () => {
  // The tie block must be the FIRST bracket a matching value could reach -- if any earlier bracket
  // also ends at that same points value, the search resolves there first (an exact match at a
  // bracket's own boundary, not the degenerate path), so this specifically has no earlier bracket.
  const tiedCurve: readonly PercentileCurvePoint[] = [
    { rank: 1, points: 150 },
    { rank: 500, points: 150 }, // same points as the previous sample -- a real observed tie block
    { rank: 2000, points: 100 },
  ];
  const result = estimateRankFromPoints(tiedCurve, TOTAL_PLAYERS, 150);
  assert.deepEqual(result, { rank: 250.5, clamped: "none" });
});

test("estimateRankFromPoints: a single-point curve treats any lower score as below-range and any higher as above-range", () => {
  const single: readonly PercentileCurvePoint[] = [{ rank: 1, points: 100 }];
  assert.deepEqual(estimateRankFromPoints(single, TOTAL_PLAYERS, 100), { rank: 1, clamped: "none" });
  assert.deepEqual(estimateRankFromPoints(single, TOTAL_PLAYERS, 150), { rank: 1, clamped: "above-range" });
  assert.deepEqual(estimateRankFromPoints(single, TOTAL_PLAYERS, 50), { rank: TOTAL_PLAYERS, clamped: "below-range" });
});

function populationResult(overrides: Partial<Extract<PopulationPercentileResult, { status: "available" }>> = {}): PopulationPercentileResult {
  return {
    status: "available",
    eventId: 6,
    eventFinished: false,
    totalPlayers: TOTAL_PLAYERS,
    curve,
    sampledAt: "2026-09-01T00:00:00.000Z",
    stale: false,
    omittedSamples: 0,
    recentAverageGameweekScore: 50,
    ...overrides,
  };
}

test("estimateRankDistribution: propagates an unavailable population curve honestly, not a fabricated estimate", () => {
  const result = estimateRankDistribution({
    candidateScenarioTotals: [60, 65, 55],
    candidateAdditionalHitCost: 0,
    currentRealTotal: 150,
    currentRealRank: 500_000,
    horizonWeeks: 1,
    horizonTier: "near-term",
    populationPercentiles: { status: "unavailable", reason: "Official FPL bootstrap-static request failed with status 503." },
  });
  assert.deepEqual(result, { status: "unavailable", reason: "Official FPL bootstrap-static request failed with status 503." });
});

test("estimateRankDistribution: zero scenarios is unavailable, not an empty-but-available result", () => {
  const result = estimateRankDistribution({
    candidateScenarioTotals: [],
    candidateAdditionalHitCost: 0,
    currentRealTotal: 150,
    currentRealRank: 500_000,
    horizonWeeks: 1,
    horizonTier: "near-term",
    populationPercentiles: populationResult(),
  });
  assert.equal(result.status, "unavailable");
});

test("estimateRankDistribution: the population-growth correction shift is horizonWeeks times the real most-recent average, not zero and not invented", () => {
  const result = estimateRankDistribution({
    candidateScenarioTotals: [40],
    candidateAdditionalHitCost: 0,
    currentRealTotal: 100,
    currentRealRank: 1_000_000,
    horizonWeeks: 3,
    horizonTier: "near-term",
    populationPercentiles: populationResult({ recentAverageGameweekScore: 50 }),
  });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.correctionShift, 150); // 3 * 50
});

test("estimateRankDistribution: no finished gameweek yet means zero correction, explicitly disclosed as no correction, not silently treated the same as a real zero-growth estimate", () => {
  const result = estimateRankDistribution({
    candidateScenarioTotals: [40],
    candidateAdditionalHitCost: 0,
    currentRealTotal: 100,
    currentRealRank: 1_000_000,
    horizonWeeks: 3,
    horizonTier: "near-term",
    populationPercentiles: populationResult({ recentAverageGameweekScore: null }),
  });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.correctionShift, 0);
  assert.ok(result.assumptions.some(text => /no gameweek has finished yet/i.test(text)));
});

test("estimateRankDistribution: hit cost and the correction shift both reduce the projected total before mapping through the curve -- hand-verified", () => {
  // currentRealTotal=100, scenario total=90, hitCost=4, correctionShift=3*10=30
  // projectedTotal = 100 + 90 - 4 - 30 = 156 -- bracket (200,1)-(180,100): t=(200-156)/20=2.2 -> out of [0,1]??
  // Use a projectedTotal that lands cleanly inside a bracket instead, verified by hand:
  // 100 + 60 - 4 - 6 = 150 -> exact match on curve[2] (rank 10000).
  const result = estimateRankDistribution({
    candidateScenarioTotals: [60],
    candidateAdditionalHitCost: 4,
    currentRealTotal: 100,
    currentRealRank: 1,
    horizonWeeks: 1,
    horizonTier: "near-term",
    populationPercentiles: populationResult({ recentAverageGameweekScore: 6 }),
  });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.correctionShift, 6);
  assert.equal(result.estimatedRanks[0], 10_000);
});

test("estimateRankDistribution: improve/worsen/unchanged are raw modeled scenario frequencies compared to the REAL current rank, no invented significance threshold", () => {
  // currentRealRank=100000 (arbitrary, between all clamp cases). Three scenarios: one that maps
  // clearly better (rank 1), one clearly worse (rank TOTAL_PLAYERS via below-range), one exactly
  // equal to currentRealRank via a crafted total.
  const result = estimateRankDistribution({
    candidateScenarioTotals: [300, 10, 150], // -> points 300 (above-range, rank1), 10 (below-range), 150 (exact rank 10000)
    candidateAdditionalHitCost: 0,
    currentRealTotal: 0,
    currentRealRank: 10_000, // matches the third scenario's exact interpolated rank
    horizonWeeks: 0,
    horizonTier: "near-term",
    populationPercentiles: populationResult({ recentAverageGameweekScore: null }), // no shift, keep the numbers clean
  });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.deepEqual(result.estimatedRanks, [1, TOTAL_PLAYERS, 10_000]);
  assert.deepEqual(result.improve, { count: 1, rate: 1 / 3 });
  assert.deepEqual(result.worsen, { count: 1, rate: 1 / 3 });
  assert.deepEqual(result.unchanged, { count: 1, rate: 1 / 3 });
  assert.equal(result.clampedAboveCount, 1);
  assert.equal(result.clampedBelowCount, 1);
});

test("estimateRankDistribution: assumptions disclose staleness and omitted samples when the curve reports them, not silently", () => {
  const result = estimateRankDistribution({
    candidateScenarioTotals: [60],
    candidateAdditionalHitCost: 0,
    currentRealTotal: 90,
    currentRealRank: 10_000,
    horizonWeeks: 1,
    horizonTier: "extended",
    populationPercentiles: populationResult({ stale: true, omittedSamples: 3 }),
  });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.ok(result.assumptions.some(text => /stale/i.test(text)));
  assert.ok(result.assumptions.some(text => /3 of the population sample points/i.test(text)));
  assert.ok(result.assumptions.some(text => /extended-horizon uncertainty/i.test(text)), "extended tier must get its own compounding disclosure");
});

test("estimateRankDistribution: near-term tier does not claim the extended-horizon compounding disclosure", () => {
  const result = estimateRankDistribution({
    candidateScenarioTotals: [60],
    candidateAdditionalHitCost: 0,
    currentRealTotal: 90,
    currentRealRank: 10_000,
    horizonWeeks: 1,
    horizonTier: "near-term",
    populationPercentiles: populationResult(),
  });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.assumptions.some(text => /extended-horizon uncertainty/i.test(text)), false);
});
