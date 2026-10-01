import { SUPPORT_EMAIL } from "../lib/site";

/** Privacy / Terms / Support links — used on the footer, /pay, /signin and the season-pass box. */
export function LegalLinks({ className = "paper-legal" }: { className?: string }) {
  return <nav className={className} aria-label="Legal and support">
    <a href="/privacy">Privacy</a>
    <a href="/terms">Terms</a>
    <a href={`mailto:${SUPPORT_EMAIL}`}>Support: {SUPPORT_EMAIL}</a>
  </nav>;
}
