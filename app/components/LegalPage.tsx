import Link from "next/link";
import { PaperStyles } from "./PaperStyles";
import { Wordmark } from "./Wordmark";
import { LegalLinks } from "./LegalLinks";

export function LegalPage({ label, title, children }: { label: string; title: string; children: React.ReactNode }) {
  return <main className="paper paper-form-page">
    <PaperStyles />
    <header className="paper-header">
      <div className="paper-wrap paper-header-inner">
        <Link className="paper-wordmark" href="/" aria-label="FPL Edge home"><Wordmark/></Link>
        <Link className="paper-signin" href="/">Back to site</Link>
      </div>
    </header>
    <div className="paper-wrap paper-form-wrap">
      <article className="paper-form paper-legal-page">
        <p className="paper-label">{label}</p>
        <h1 className="paper-form-title">{title}</h1>
        {children}
        <LegalLinks />
      </article>
    </div>
  </main>;
}
