import type { PercentileCurvePoint, PopulationPercentileResult } from "./population-percentile-core";
import type { DecisionHorizonTier } from "./decision-confidence";

export type RankClamp = "none" | "above-range" | "below-range";

export type RankEstimate = Readonly<{ rank: number; clamped: RankClamp }>;

/**
 * Linear interpolation of rank as a function of points, between the two real sampled curve points
 * that bracket `points`. Deliberately linear, not log-linear or spline-fit: a fancier curve would
 * imply more precision than ~29 real sampled points actually support -- this only ever connects two
 * observed values, inventing nothing between them.
 *
 * `curve` must be sorted ascending by rank (== descending by points), as population-percentile-
 * core.ts's buildCurveFromSamples already guarantees.
 */
export function estimateRankFromPoints(
  curve: readonly PercentileCurvePoint[],
  totalPlayers: number,
  points: number,
): RankEstimate {
  if (!curve.length) throw new Error("Population curve must have at least one point.");
  const first = curve[0];
  const last = curve[curve.length - 1];
  // Strictly better than the real recorded #1: can't go below rank 1, and this is genuinely rare.
  if (points > first.points) return { rank: first.rank, clamped: "above-range" };
  // Strictly worse than the worst sample: totalPlayers (the real population size) is a more honest
  // ceiling than the last sample's rank, which can itself be an undercount (Phase 1's own final-
  // page-overshoot edge case).
  if (points < last.points) return { rank: totalPlayers, clamped: "below-range" };
  // A single-point curve has no bracket to interpolate within; an exact match to that one point
  // (the only case that reaches here without being clamped above/below) is that point's real rank.
  if (curve.length === 1) return { rank: first.rank, clamped: "none" };
  for (let index = 0; index < curve.length - 1; index++) {
    const a = curve[index];
    const b = curve[index + 1];
    if (points <= a.points && points >= b.points) {
      if (a.points === b.points) {
        // A real, verifiably tied block between two adjacent samples -- every manager in the gap
        // shares the identical points value, so no single rank in [a.rank, b.rank] is more correct
        // than another. Midpoint is the least arbitrary single choice, not a fabricated precision.
        return { rank: (a.rank + b.rank) / 2, clamped: "none" };
      }
      const t = (a.points - points) / (a.points - b.points);
      return { rank: a.rank + t * (b.rank - a.rank), clamped: "none" };
    }
  }
  throw new Error("Point value did not bracket within the sampled curve despite passing range checks.");
}

export type RankEstimateResult =
  | {
      status: "available";
      currentRank: number;
      correctionShift: number;
      estimatedRanks: readonly number[];
      bestRank: number;
      medianRank: number;
      worstRank: number;
      clampedAboveCount: number;
      clampedBelowCount: number;
      improve: { count: number; rate: number };
      worsen: { count: number; rate: number };
      unchanged: { count: number; rate: number };
      assumptions: readonly string[];
    }
  | { status: "unavailable"; reason: string };

function quantile(sorted: readonly number[], probability: number): number {
  const clamped = Math.max(0, Math.min(1, probability));
  const index = Math.max(0, Math.ceil(clamped * sorted.length) - 1);
  return sorted[Math.min(sorted.length - 1, index)];
}

export function estimateRankDistribution(input: {
  candidateScenarioTotals: readonly number[];
  candidateAdditionalHitCost: number;
  currentRealTotal: number;
  currentRealRank: number;
  horizonWeeks: number;
  horizonTier: DecisionHorizonTier;
  populationPercentiles: PopulationPercentileResult;
}): RankEstimateResult {
  if (input.populationPercentiles.status === "unavailable") {
    return { status: "unavailable", reason: input.populationPercentiles.reason };
  }
  if (!input.candidateScenarioTotals.length) {
    return { status: "unavailable", reason: "No modeled scenarios are available to estimate a rank from." };
  }
  const pct = input.populationPercentiles;
  // Real-data correction (approved over disclosure-only): the population curve reflects today's
  // cumulative snapshot, but the projection adds horizonWeeks of future points to the user's own
  // total. Left uncorrected, every projection would look systematically better than it truly would,
  // since the comparison population hasn't yet banked those same future weeks' points either. Shift
  // the curve by the real, most-recently-finished gameweek's average_entry_score (see
  // population-percentile.ts's fetchCurrentEvent for why that window, not season-to-date) times the
  // horizon length -- a real, disclosed estimate, not zero (which is equivalent to assuming no
  // population growth at all) and not a fabricated precise correction.
  const correctionShift = pct.recentAverageGameweekScore === null ? 0 : input.horizonWeeks * pct.recentAverageGameweekScore;

  let clampedAboveCount = 0;
  let clampedBelowCount = 0;
  const estimatedRanks = input.candidateScenarioTotals.map(total => {
    const projectedTotal = input.currentRealTotal + total - input.candidateAdditionalHitCost - correctionShift;
    const estimate = estimateRankFromPoints(pct.curve, pct.totalPlayers, projectedTotal);
    if (estimate.clamped === "above-range") clampedAboveCount++;
    if (estimate.clamped === "below-range") clampedBelowCount++;
    return estimate.rank;
  });

  const sorted = [...estimatedRanks].sort((a, b) => a - b);
  let improveCount = 0, worsenCount = 0, unchangedCount = 0;
  for (const rank of estimatedRanks) {
    if (rank < input.currentRealRank) improveCount++;
    else if (rank > input.currentRealRank) worsenCount++;
    else unchangedCount++;
  }
  const scenarioCount = estimatedRanks.length;

  const assumptions = [...new Set([
    `Based on a ${pct.curve.length}-point sample of the real official "Overall" league standings, sampled ${pct.sampledAt}.`,
    pct.stale ? "This population sample is stale: the official source could not be refreshed, so a cached snapshot is being used." : null,
    pct.omittedSamples > 0 ? `${pct.omittedSamples} of the population sample points came back empty or malformed and were omitted.` : null,
    correctionShift !== 0
      ? `Shifted by ${correctionShift >= 0 ? "+" : ""}${correctionShift.toFixed(0)} points to estimate how much the rest of the population will also score over these ${input.horizonWeeks} gameweek${input.horizonWeeks === 1 ? "" : "s"}, using the real average score from the most recently finished gameweek -- itself an approximation of future scoring, not a guarantee.`
      : "No population-growth correction was applied: no gameweek has finished yet this season to estimate one from.",
    input.horizonTier === "extended"
      ? "This estimate inherits the same extended-horizon uncertainty as the underlying projection: 6 or more gameweeks of this app's own form model held constant, which compounds with the population-growth estimate above."
      : "This estimate inherits the underlying projection's own near-term assumptions (see the Decision Confidence disclosure above).",
    clampedAboveCount > 0 ? `${clampedAboveCount} modeled scenario${clampedAboveCount === 1 ? "" : "s"} exceeded the best real sampled score and were shown as rank 1.` : null,
    clampedBelowCount > 0 ? `${clampedBelowCount} modeled scenario${clampedBelowCount === 1 ? "" : "s"} fell below the worst real sampled score and were shown at the real population size.` : null,
    "Estimated ranks are interpolated between real sampled points, not a calibrated prediction -- treat them as directional.",
  ].filter((line): line is string => line !== null))];

  return {
    status: "available",
    currentRank: input.currentRealRank,
    correctionShift,
    estimatedRanks,
    bestRank: quantile(sorted, .1),
    medianRank: quantile(sorted, .5),
    worstRank: quantile(sorted, .9),
    clampedAboveCount,
    clampedBelowCount,
    improve: { count: improveCount, rate: improveCount / scenarioCount },
    worsen: { count: worsenCount, rate: worsenCount / scenarioCount },
    unchanged: { count: unchangedCount, rate: unchangedCount / scenarioCount },
    assumptions,
  };
}

export type LiveRankResult =
  | { status: "available"; rank: RankEstimate; assumptions: readonly string[] }
  | { status: "unavailable"; reason: string };

/**
 * Maps a real, current live overall-points total through the same real sampled curve used for
 * simulated future scenarios -- estimateRankFromPoints has no notion of "simulated" vs "live", a
 * points value is a points value. The one thing that genuinely differs for a live use case is
 * disclosure: the population curve refreshes at most every 2 hours while a gameweek is live
 * (POPULATION_PERCENTILE_TTL_LIVE_MS in population-percentile-core.ts), while a manager's own live
 * points can move every few minutes during matches -- that asymmetry must be stated, not silently
 * assumed away, so it's included here as a real assumptions-array entry rather than a code comment.
 */
export function estimateLiveRankResult(
  populationPercentiles: PopulationPercentileResult,
  currentOverallPoints: number,
): LiveRankResult {
  if (populationPercentiles.status === "unavailable") {
    return { status: "unavailable", reason: populationPercentiles.reason };
  }
  const pct = populationPercentiles;
  const rank = estimateRankFromPoints(pct.curve, pct.totalPlayers, currentOverallPoints);
  const assumptions = [...new Set([
    `Based on a ${pct.curve.length}-point sample of the real official "Overall" league standings, sampled ${pct.sampledAt}.`,
    pct.stale ? "This population sample is stale: the official source could not be refreshed, so a cached snapshot is being used." : null,
    pct.omittedSamples > 0 ? `${pct.omittedSamples} of the population sample points came back empty or malformed and were omitted.` : null,
    !pct.eventFinished
      ? "This population sample refreshes at most every 2 hours while a gameweek is live, while your own live points can change every few minutes -- the comparison population may lag behind live match action."
      : null,
    rank.clamped === "above-range" ? "Your live total exceeded the best real sampled score; rank is shown as 1 rather than extrapolated below it." : null,
    rank.clamped === "below-range" ? "Your live total fell below the worst real sampled score; rank is shown at the real population size rather than extrapolated." : null,
    "This is an estimate interpolated between real sampled points, not FPL's own official rank calculation -- treat it as directional.",
  ].filter((line): line is string => line !== null))];
  return { status: "available", rank, assumptions };
}
