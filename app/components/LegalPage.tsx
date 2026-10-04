import Link from "next/link";
import { PaperStyles } from "./PaperStyles";
import { PaperHeader } from "./PaperHeader";
import { LegalLinks } from "./LegalLinks";

export function LegalPage({ label, title, children }: { label: string; title: string; children: React.ReactNode }) {
  return <main className="paper paper-form-page">
    <PaperStyles />
    <PaperHeader action={{ href: "/", label: "Back to site" }} />
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
