"use client";

import "../components/PaperStyles";
import { AuthForm } from "../components/AuthForm";
import { PaperHeader } from "../components/PaperHeader";
import { LegalLinks } from "../components/LegalLinks";

export default function Page() {
  return <main className="paper paper-form-page">
    <PaperHeader action={{ href: "/signup?return_to=%2F%3Fapp%3D1", label: "Sign up" }} />
    <div className="paper-wrap paper-form-wrap">
      <AuthForm mode="signin" />
      <LegalLinks />
    </div>
  </main>;
}
