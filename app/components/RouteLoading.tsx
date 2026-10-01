/* eslint-disable @next/next/no-html-link-for-pages -- wordmark link matches the other paper shell pages (plain <a>, full navigation) */
import { PaperStyles } from "./PaperStyles";
import { Wordmark } from "./Wordmark";

// Shared body for the loading.tsx files under app/signin, app/signup and app/pay (Suspense fallback).
// Deliberately NOT app/loading.tsx: a root loading boundary makes vinext stream the public homepage
// as fallback + hidden content that only appears once inline JS runs, which changes its SSR output.
// Server component, no data: the branded shell plus a quiet pulsing bar, so navigation never shows a blank frame.
export function RouteLoading() {
  return <main className="paper paper-form-page" aria-busy="true" aria-live="polite">
    <PaperStyles />
    <header className="paper-header">
      <div className="paper-wrap paper-header-inner">
        <a className="paper-wordmark" href="/" aria-label="FPL Edge home"><Wordmark/></a>
      </div>
    </header>
    <div className="paper-wrap paper-form-wrap">
      <section className="paper-form">
        <p className="paper-label">Loading</p>
        <div className="paper-loading-bar" aria-hidden="true"/>
        <span className="paper-sr-only">Loading your decision desk…</span>
      </section>
    </div>
  </main>;
}
