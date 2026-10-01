"use client";

import { useEffect, useState } from "react";
import { track } from "../lib/track";

function nextPath(): string {
  if (typeof window === "undefined") return "/?app=1";
  const raw = new URLSearchParams(window.location.search).get("return_to");
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/?app=1";
  return raw;
}

const SIGNUP_FOLLOWUP_FAILED = "We could not finish setting up this account. If you already have an account with this email, sign in with your existing password.";

export function AuthForm({ mode }: { mode: "signin" | "signup" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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
      const post = (path: string) => fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const response = await post(mode === "signup" ? "/api/auth/signup" : "/api/auth/login");
      const json = await response.json() as { error?: string };
      if (!response.ok) throw new Error(json.error || (mode === "signup" ? "Could not create account." : "Could not sign in."));
      if (mode === "signup") {
        // Signup answers identically for new and existing emails and sets no session (no account-existence oracle),
        // so sign in explicitly. This succeeds for a new account (or an existing one with this same password).
        const login = await post("/api/auth/login");
        if (!login.ok) {
          const loginJson = await login.json().catch(() => ({})) as { error?: string };
          throw new Error(login.status === 429 && loginJson.error ? loginJson.error : SIGNUP_FOLLOWUP_FAILED);
        }
      }
      track("signin_success", { mode });
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
    <div className="paper-field">
      <label htmlFor="auth-password">Password</label>
      <span className="paper-password">
        <input id="auth-password" type={showPassword ? "text" : "password"} autoComplete={mode === "signup" ? "new-password" : "current-password"} placeholder={mode === "signup" ? "8 to 128 characters" : ""} maxLength={mode === "signup" ? 128 : undefined} value={password} onChange={(event) => setPassword(event.target.value)} />
        <button type="button" className="paper-password-toggle" aria-pressed={showPassword} aria-controls="auth-password" aria-label="Show password" onClick={() => setShowPassword((value) => !value)}>{showPassword ? "Hide" : "Show"}</button>
      </span>
    </div>
    {message && <p className="paper-form-message" role="alert">{message}</p>}
    <div className="paper-form-actions">
      <button type="submit" className="paper-btn paper-form-submit" disabled={busy}>{busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}</button>
    </div>
    <p className="paper-form-switch">{mode === "signin" ? "New here?" : "Already have an account?"} <a href={otherHref}>{mode === "signin" ? "Create an account" : "Sign in"}</a></p>
  </form>;
}
