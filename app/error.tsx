/* eslint-disable @next/next/no-html-link-for-pages -- error boundary: a hard navigation to "/" is the safest recovery, so plain <a> (same as not-found.tsx and the auth/pay pages) */
"use client";

import "./globals.css";
import "./styles/paper.css";
import { useEffect } from "react";
import { Wordmark } from "./components/Wordmark";

// Route-level error boundary (renders inside the root layout, so fonts/theme/tokens apply).
// `reset` re-renders the failed segment; the home link is the always-safe way out.
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Keep the underlying error visible to operators (console / Workers logs) without showing it to users.
    console.error("[route-error]", error?.digest ?? "", error);
  }, [error]);

  return <main className="paper paper-form-page" role="alert">
    <header className="paper-header">
      <div className="paper-wrap paper-header-inner">
        <a className="paper-wordmark" href="/" aria-label="FPL Edge home"><Wordmark/></a>
      </div>
    </header>
    <div className="paper-wrap paper-form-wrap">
      <section className="paper-form">
        <p className="paper-label">Something went wrong</p>
        <h1 className="paper-form-title">The desk hit a snag.</h1>
        <p className="paper-form-lead">That was on our side, not yours. Try again, or head back home and pick up from there.</p>
        <div className="paper-form-actions">
          <button type="button" className="paper-btn" onClick={() => reset()}>Try again</button>
          <a className="paper-btn paper-demo" href="/">Back to home</a>
        </div>
      </section>
    </div>
  </main>;
}
