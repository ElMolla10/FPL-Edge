import { LegalPage } from "../components/LegalPage";
import { SUPPORT_EMAIL } from "../lib/site";

export default function PrivacyPage() {
  return <LegalPage label="Privacy" title="What we store, in plain words.">
    <ul className="paper-lines paper-form-list">
      <li><b>FPL data.</b> Player, fixture and team data come from the official public Fantasy Premier League feed. If you connect your team we read it by FPL team ID — read only.</li>
      <li><b>No FPL password.</b> We never ask for, see or store your FPL password. You make every transfer on FPL yourself.</li>
      <li><b>Your email.</b> Used to sign you in and to link your season pass to your account. If you opt in, we also email you when this week&apos;s call changes. No marketing lists, no selling.</li>
      <li><b>Your password here.</b> Stored only as a salted hash. We cannot read it.</li>
      <li><b>Payments.</b> Card details go to Paymob, our payment provider. We never see or store your card number; we only keep whether the payment was confirmed.</li>
      <li><b>Your phone number.</b> Asked at checkout because Paymob requires it for the payment.</li>
      <li><b>On your device.</b> Your saved squad and settings live in your browser storage.</li>
      <li><b>Deleting your data.</b> Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> from your account email and we will delete your account.</li>
    </ul>
    <p className="paper-note">FPL Edge is independent and not affiliated with the Premier League or Fantasy Premier League.</p>
  </LegalPage>;
}
