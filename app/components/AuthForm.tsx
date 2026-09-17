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
  const chatgptHref = `/signin-with-chatgpt?return_to=${encodeURIComponent(destination)}`;

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

  return <section className="season-upgrade">
    <span>{mode === "signin" ? "SIGN IN" : "CREATE ACCOUNT"}</span>
    <h2>{mode === "signin" ? "Sign in to your desk." : "Create your FPL Edge account."}</h2>
    <p>{mode === "signin"
      ? "The season pass is attached to this account. Sign in, then come back to pay if you still need it."
      : "Use an email and a password of at least 8 characters. The free desk is this gameweek. The season pass opens the rest."}</p>
    <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
    <label>Password<input type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} placeholder={mode === "signup" ? "At least 8 characters" : ""} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
    <div className="season-upgrade-actions">
      <button type="button" onClick={submit} disabled={busy}>{busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}</button>
    </div>
    <a className="chatgpt-signin" href={chatgptHref}>Sign in with ChatGPT</a>
    <p className="season-note">{mode === "signin" ? "New here?" : "Already have an account?"} <a href={otherHref}>{mode === "signin" ? "Create an account" : "Sign in"}</a></p>
    {message && <p className="season-note">{message}</p>}
  </section>;
}
