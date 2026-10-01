import { formatSeasonPassPrice } from "../lib/season-pass";

// Locked-feature card shown inside the app for signed-in accounts without a pass. Lives apart from SeasonPass.tsx
// (the /pay checkout form) so the decision desk does not ship the Paymob checkout code and /pay does not ship this.
export function SeasonLocked({ feature, onUpgrade }: { feature: string; onUpgrade: () => void }) {
  return <section className="season-locked">
    <span>SEASON PASS</span>
    <h2>{feature}</h2>
    <p>Free covers one active team, the current gameweek projection, the lineup and captain recommendation, and one transfer scenario. The season pass is {formatSeasonPassPrice()} for the rest of this FPL season — not a monthly plan.</p>
    <button type="button" onClick={onUpgrade}>Upgrade for {formatSeasonPassPrice()}</button>
  </section>;
}
