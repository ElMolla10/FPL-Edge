"use client";

import { AuthForm } from "../components/AuthForm";

export default function SignUpPage() {
  return <main className="marketing-page pay-page">
    <header className="site-header">
      <a className="brand" href="/" aria-label="FPL Edge home"><span className="brand-mark">E</span><span>FPL EDGE</span></a>
      <a className="text-link" href="/signin?return_to=%2F%3Fapp%3D1">Sign in</a>
    </header>
    <section className="section pay-section">
      <AuthForm mode="signup" />
    </section>
  </main>;
}
