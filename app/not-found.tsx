import type { Metadata } from "next";
import { PaperStyles } from "./components/PaperStyles";
import { PaperHeader } from "./components/PaperHeader";

// vinext does not apply a not-found file's `metadata` export to the 404 response, so the same title is
// also rendered as a React 19 <title>, which is hoisted into <head> and replaces the root default.
const NOT_FOUND_TITLE = "Page not found — FPL Edge";

export const metadata: Metadata = {
  title: NOT_FOUND_TITLE,
  description: "This page does not exist. Head back to FPL Edge for this week's lineup, captain and transfer call.",
  robots: { index: false, follow: true },
};


export default function NotFound() {
  return <main className="paper paper-form-page">
    <PaperStyles />
    <title>{NOT_FOUND_TITLE}</title>
    <meta name="robots" content="noindex, follow" />
    <PaperHeader action={{ href: "/signin?return_to=%2F%3Fapp%3D1", label: "Sign in" }} />
    <div className="paper-wrap paper-form-wrap">
      <section className="paper-form">
        <p className="paper-label">Page not found</p>
        <h1 className="paper-form-title">This page is offside.</h1>
        <p className="paper-form-lead">The link may be old or mistyped. Your decision desk is one tap away.</p>
        <div className="paper-form-actions"><a className="paper-btn" href="/">Back to home</a></div>
      </section>
    </div>
  </main>;
}
