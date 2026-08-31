import { isTransferSensitivityRetryable, type TransferSensitivityDisplayState } from "../lib/transfer-decision-ui";

const factorLabel = {
  "expected-minutes": "Expected minutes / appearance",
  "attacking-return-rate": "Attacking return rate",
  "clean-sheet-probability": "Clean-sheet probability",
} as const;

type Props = {
  state: TransferSensitivityDisplayState;
  onRetry?: () => void;
  retryDisabled?: boolean;
};

function Retry({ onRetry, disabled }: { onRetry: () => void; disabled?: boolean }) {
  return <button type="button" onClick={onRetry} disabled={disabled}>Retry Decision Confidence and sensitivity</button>;
}

export default function TransferSensitivityPanel({ state, onRetry, retryDisabled }: Props) {
  if (state.status === "pending") return <section className="transfer-sensitivity-card pending" aria-live="polite" aria-busy="true"><span>BREAK-EVEN SENSITIVITY</span><h3>Calculating break-even sensitivity…</h3><p>The completed Decision Confidence result remains visible while each factor is tested independently.</p></section>;
  if (state.status === "unavailable") return <section className="transfer-sensitivity-card unavailable" aria-live="polite"><span>BREAK-EVEN SENSITIVITY</span><h3>Sensitivity unavailable</h3><p>{state.reason}</p>{onRetry&&isTransferSensitivityRetryable(state)&&<Retry onRetry={onRetry} disabled={retryDisabled}/>}</section>;
  if (state.status === "error") return <section className="transfer-sensitivity-card error" aria-live="assertive"><span>BREAK-EVEN SENSITIVITY</span><h3>Unexpected sensitivity failure</h3><p>{state.reason}</p>{onRetry&&<Retry onRetry={onRetry} disabled={retryDisabled}/>}</section>;
  return <section className="transfer-sensitivity-card available" aria-live="polite">
    <header><span>Break-even sensitivity</span><h3>What would reverse the expected net decision?</h3><p>Each factor is varied independently while the optimizer plan and all other assumptions remain fixed.</p></header>
    <div>{state.result.factors.map(factor => <article key={factor.factor} className={factor.status}>
      <b>{factorLabel[factor.factor]}</b>
      <p>{factor.status === "available" ? factor.message : factor.reason}</p>
    </article>)}</div>
    <details><summary>Sensitivity assumptions</summary>{state.result.assumptions.map(assumption => <p key={assumption}>{assumption}</p>)}</details>
  </section>;
}
