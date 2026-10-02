"use client";

import "../components/PaperStyles";
import { AuthForm } from "../components/AuthForm";
import { Wordmark } from "../components/Wordmark";
import { LegalLinks } from "../components/LegalLinks";

export default function Page() {
  return <main className="paper paper-form-page">
    <header className="paper-header">
      <div className="paper-wrap paper-header-inner">
        <a className="paper-wordmark" href="/" aria-label="FPL Edge home"><Wordmark/></a>
        <a className="paper-signin" href="/signup?return_to=%2F%3Fapp%3D1">Sign up</a>
      </div>
    </header>
    <div className="paper-wrap paper-form-wrap">
      <AuthForm mode="signin" />
      <LegalLinks />
    </div>
  </main>;
}
