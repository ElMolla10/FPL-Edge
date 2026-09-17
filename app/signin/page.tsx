"use client";

import { AuthForm } from "../components/AuthForm";

export default function SignInPage() {
  return <main className="marketing-page pay-page">
    <header className="site-header">
      <a className="brand" href="/" aria-label="FPL Edge home"><span className="brand-mark">E</span><span>FPL EDGE</span></a>
      <a className="text-link" href="/signup?return_to=%2F%3Fapp%3D1">Sign up</a>
    </header>
    <section className="section pay-section">
      <AuthForm mode="signin" />
    </section>
  </main>;
}
