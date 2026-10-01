import { LegalPage } from "../components/LegalPage";
import { PASS_END_DATE_LABEL, SUPPORT_EMAIL } from "../lib/site";
import { formatSeasonPassPrice } from "../lib/season-pass";

export default function TermsPage() {
  return <LegalPage label="Terms" title="The season pass, simply.">
    <ul className="paper-lines paper-form-list">
      <li><b>What it is.</b> A one-time payment of {formatSeasonPassPrice()} that unlocks the full decision desk. Not a subscription — nothing renews.</li>
      <li><b>How long.</b> The pass is tied to your FPL Edge account and lasts through {PASS_END_DATE_LABEL}.</li>
      <li><b>Payment.</b> Handled by Paymob. Your pass turns on only after Paymob confirms the payment.</li>
      <li><b>Advice, not guarantees.</b> Projections are estimates from official FPL data. You decide and make every move on FPL yourself.</li>
      <li><b>Your account.</b> One person per account. Keep your sign-in details private.</li>
      <li><b>Problems or refunds.</b> Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and we will sort it out.</li>
    </ul>
    <p className="paper-note">FPL Edge is independent and not affiliated with the Premier League or Fantasy Premier League.</p>
  </LegalPage>;
}
