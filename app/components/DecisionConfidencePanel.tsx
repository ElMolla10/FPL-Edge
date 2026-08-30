import type { DecisionConfidenceAvailable } from "../lib/decision-confidence";
import type { DecisionConfidenceDisplayState } from "../lib/decision-confidence-worker";

const finite = (value: number | null) => value === null || Number.isFinite(value);
const validResult = (result: DecisionConfidenceAvailable) => [
  result.scenarioCount, result.availableGameweeks, result.frequencies.gain.count, result.frequencies.gain.rate,
  result.frequencies.tie.count, result.frequencies.tie.rate, result.frequencies.loss.count, result.frequencies.loss.rate,
  result.expectedDelta, result.p10, result.p50, result.p90, result.preferredAlternativeScenarioWinRate,
].every(finite);
const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`;
const signed = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(1)}`;

export default function DecisionConfidencePanel({ title, state, candidateLabel, baselineLabel }: {
  title: string;
  state: DecisionConfidenceDisplayState;
  candidateLabel: string;
  baselineLabel: string;
}) {
  if (state.status === "pending") return <section className="decision-confidence-card pending" aria-live="polite" aria-busy="true"><span>{title}</span><h3>Calculating 1,024 modeled scenarios…</h3><p>The updated squad is ready while Decision Confidence runs in the background.</p></section>;
  if (state.status === "unavailable") return <section className="decision-confidence-card unavailable" aria-live="polite"><span>{title}</span><h3>Decision Confidence unavailable</h3><p>{state.reason}</p></section>;
  if (state.status === "error") return <section className="decision-confidence-card error" aria-live="assertive"><span>{title}</span><h3>Unexpected calculation failure</h3><p>{state.reason}</p></section>;
  const result = state.result;
  if (!validResult(result)) return <section className="decision-confidence-card error" aria-live="assertive"><span>{title}</span><h3>Unexpected calculation failure</h3><p>Decision Confidence returned a non-finite result and it was not displayed.</p></section>;

  const preferred = result.preferred === "candidate" ? candidateLabel : result.preferred === "baseline" ? baselineLabel : "Tie";
  const winRate = result.preferredAlternativeScenarioWinRate === null ? "Not applicable for a tie" : percent(result.preferredAlternativeScenarioWinRate);
  return <section className="decision-confidence-card available" aria-live="polite">
    <header><div><span>{title}</span><small>Preferred decision</small><h3>{preferred}</h3></div><strong className={result.label.toLowerCase().replaceAll(" ", "-")}>{result.label}</strong></header>
    <div className="decision-confidence-primary"><article><span>Modeled scenario win rate</span><b>{winRate}</b></article><article><span>Expected net points delta after hit cost</span><b>{signed(result.expectedDelta)} pts</b></article></div>
    <div className="decision-confidence-frequencies"><article><span>Gain</span><b>{percent(result.frequencies.gain.rate)}</b></article><article><span>Tie</span><b>{percent(result.frequencies.tie.rate)}</b></article><article><span>Loss</span><b>{percent(result.frequencies.loss.rate)}</b></article></div>
    <div className="decision-confidence-percentiles"><article><span>P10 downside</span><b>{signed(result.p10)}</b></article><article><span>P50 median</span><b>{signed(result.p50)}</b></article><article><span>P90 upside</span><b>{signed(result.p90)}</b></article></div>
    <p className="decision-confidence-scope">{result.scenarioCount.toLocaleString("en-GB")} modeled scenarios · {result.availableGameweeks} available gameweek{result.availableGameweeks === 1 ? "" : "s"}</p>
    <details><summary>Assumptions and disclosure</summary>{result.assumptions.map(assumption => <p key={assumption}>{assumption}</p>)}</details>
  </section>;
}
