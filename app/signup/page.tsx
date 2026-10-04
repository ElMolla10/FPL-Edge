"use client";

import "../components/PaperStyles";
import { AuthForm } from "../components/AuthForm";
import { PaperHeader } from "../components/PaperHeader";

export default function Page() {
  return <main className="paper paper-form-page">
    <PaperHeader action={{ href: "/signin?return_to=%2F%3Fapp%3D1", label: "Sign in" }} />
    <div className="paper-wrap paper-form-wrap">
      <AuthForm mode="signup" />
    </div>
  </main>;
}
