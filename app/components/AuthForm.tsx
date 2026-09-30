"use client";

import { useEffect, useState } from "react";

function nextPath(): string {
  if (typeof window === "undefined") return "/?app=1";
  const raw = new URLSearchParams(window.location.search).get("return_to");
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/?app=1";
  return raw;
}

export function AuthForm({ mode }: { mode: "signin" | "signup" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [destination, setDestination] = useState("/?app=1");

  useEffect(() => {
    setDestination(nextPath());
  }, []);

  const other = mode === "signin" ? "signup" : "signin";
  const otherHref = `/${other}?return_to=${encodeURIComponent(destination)}`;
  const submit = async () => {
    if (!email || !password) {
      setMessage("Enter email and password.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(mode === "signup" ? "/api/auth/signup" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const json = await response.json() as { error?: string };
      if (!response.ok) throw new Error(json.error || (mode === "signup" ? "Could not create account." : "Could not sign in."));
      window.location.assign(destination);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  };

  return <form className="paper-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <p className="paper-label">{mode === "signin" ? "Sign in" : "Create account"}</p>
    <h1 className="paper-form-title">{mode === "signin" ? "Sign in to your desk." : "Create your FPL Edge account."}</h1>
    <p className="paper-form-lead">{mode === "signin"
      ? "Your season pass is attached to this account. Sign in, then come back to pay if you still need it."
      : "Free this gameweek. The season pass opens the rest."}</p>
    <label className="paper-field">Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
    <label className="paper-field">Password<input type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} placeholder={mode === "signup" ? "At least 8 characters" : ""} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
    {message && <p className="paper-form-message" role="alert">{message}</p>}
    <div className="paper-form-actions">
      <button type="submit" className="paper-btn paper-form-submit" disabled={busy}>{busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}</button>
    </div>
    <p className="paper-form-switch">{mode === "signin" ? "New here?" : "Already have an account?"} <a href={otherHref}>{mode === "signin" ? "Create an account" : "Sign in"}</a></p>
  </form>;
}
