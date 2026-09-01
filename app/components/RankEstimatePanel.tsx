import type { RankEstimateResult } from "../lib/rank-estimate-core";

const finite = (value: number) => Number.isFinite(value);
const validResult = (result: Extract<RankEstimateResult, { status: "available" }>) => [
  result.currentRank, result.correctionShift, result.bestRank, result.medianRank, result.worstRank,
  result.improve.rate, result.worsen.rate, result.unchanged.rate,
].every(finite) && result.estimatedRanks.every(finite);

const fmt = (value: number) => Math.round(value).toLocaleString("en-GB");
const pct = (rate: number) => `${(rate * 100).toFixed(1)}%`;

// result is null while the population curve is still loading (usePopulationPercentiles hasn't
// resolved yet) -- rendered as nothing, not a flashing "unavailable", since it will settle shortly.
export default function RankEstimatePanel({ title, result }: { title: string; result: RankEstimateResult | null }) {
  if (result === null) return null;
  if (result.status === "unavailable") {
    return <section className="rank-estimate-card unavailable" aria-live="polite"><span>{title}</span><h3>Rank estimate unavailable</h3><p>{result.reason}</p></section>;
  }
  if (!validResult(result)) {
    return <section className="rank-estimate-card error" aria-live="assertive"><span>{title}</span><h3>Unexpected calculation failure</h3><p>The rank estimate returned a non-finite result and it was not displayed.</p></section>;
  }
  return <section className="rank-estimate-card available" aria-live="polite">
    <header><span>{title}</span><h3>Estimated overall rank</h3><strong>{fmt(result.currentRank)}<small>current real rank</small></strong></header>
    <div className="rank-estimate-range">
      <article><span>Best 10% of scenarios</span><b>{fmt(result.bestRank)}</b></article>
      <article><span>Median scenario</span><b>{fmt(result.medianRank)}</b></article>
      <article><span>Worst 10% of scenarios</span><b>{fmt(result.worstRank)}</b></article>
    </div>
    <div className="rank-estimate-arrows">
      <article><span>Est. rank improves</span><b>{pct(result.improve.rate)}</b></article>
      <article><span>Est. rank worsens</span><b>{pct(result.worsen.rate)}</b></article>
      <article><span>No estimated change</span><b>{pct(result.unchanged.rate)}</b></article>
    </div>
    <p className="rank-estimate-scope">
      {result.correctionShift !== 0
        ? `Adjusted by ${result.correctionShift >= 0 ? "+" : ""}${Math.round(result.correctionShift)} pts for expected population growth over this horizon.`
        : "No population-growth adjustment applied."}
    </p>
    <details><summary>Assumptions and disclosure</summary>{result.assumptions.map(assumption => <p key={assumption}>{assumption}</p>)}</details>
  </section>;
}
