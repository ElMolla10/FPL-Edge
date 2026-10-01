"use client";

import { useEffect, useState } from "react";
import { formatSeasonPassPrice } from "../lib/season-pass";

// Clicking pay only starts a Paymob intention. Nothing in this file writes an "unlocked" flag.
// The desk stays gated until /api/auth/me reports an active pass from the verified callback.

export function SeasonUpgrade({ checkoutReturn, onDismiss }: { checkoutReturn?: boolean; onDismiss: () => void }) {
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [disconnected, setDisconnected] = useState(false);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [accountEmail, setAccountEmail] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: { user?: { email?: string } | null }) => {
        if (cancelled) return;
        const user = data.user ?? null;
        setSignedIn(Boolean(user));
        setAccountEmail(typeof user?.email === "string" ? user.email : "");
      })
      .catch(() => {
        if (!cancelled) setSignedIn(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pay = async () => {
    if (!signedIn) {
      setSignedIn(false);
      setMessage("Sign in first. A payment is attached to your account, not this browser.");
      return;
    }
    setBusy(true);
    setMessage("");
    setDisconnected(false);
    try {
      const response = await fetch("/api/season-pass/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const json = await response.json() as { connected?: boolean; message?: string; error?: string; checkoutUrl?: string; alreadyActive?: boolean };
      if (json.connected === false) {
        setDisconnected(true);
        setMessage(json.message || "Checkout is not connected yet.");
        return;
      }
      if (json.alreadyActive) {
        setMessage("Your season pass is already active. Refresh if the desk still looks locked.");
        return;
      }
      if (!response.ok) {
        if (response.status === 401) setSignedIn(false);
        setMessage(json.error || "Could not start checkout.");
        return;
      }
      if (!json.checkoutUrl) {
        setMessage("Checkout did not return a payment link. Nothing was unlocked.");
        return;
      }
      window.location.assign(json.checkoutUrl);
    } catch {
      setMessage("Could not reach checkout. Nothing was unlocked.");
    } finally {
      setBusy(false);
    }
  };

  return <section className="paper-form">
    <p className="paper-label">Season pass</p>
    <p className="paper-amount">{formatSeasonPassPrice()}</p>
    <h1 className="paper-form-title">Your full decision desk, for the rest of this season.</h1>
    <p className="paper-form-lead">One payment, not a monthly plan.</p>
    <ul className="paper-lines paper-form-list">
      <li>Multi-week transfer planning</li>
      <li>Safe and aggressive alternatives</li>
      <li>News impact alerts</li>
      <li>Draft and chip optimization</li>
      <li>Decision history</li>
    </ul>
    {checkoutReturn && <p className="paper-form-message">You are back from Paymob. If the payment succeeded, refresh in a moment. This return does not unlock the desk by itself.</p>}
    <ol className="paper-steps" aria-label="Checkout steps">
      <li className={signedIn ? "is-done" : "is-current"} aria-current={signedIn ? undefined : "step"}><b>1</b><span>Sign in</span></li>
      <li className={signedIn ? "is-current" : ""} aria-current={signedIn ? "step" : undefined}><b>2</b><span>Phone number</span></li>
      <li><b>3</b><span>Pay</span></li>
    </ol>
    {signedIn === false && <div className="paper-form-step">
      <p>Step 1: sign in or create an account. Your pass is attached to it.</p>
      <div className="paper-form-actions">
        <a className="paper-btn" href="/signin?return_to=%2Fpay">Sign in</a>
        <a className="paper-btn paper-demo" href="/signup?return_to=%2Fpay">Create account</a>
      </div>
    </div>}
    {signedIn && accountEmail && <p className="paper-form-switch">Signed in as {accountEmail}. The pass is attached to this account.</p>}
    {/* The phone field only appears once the session is confirmed (sign in → phone → pay). */}
    {signedIn === true && <label className="paper-field">Egyptian mobile number<input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" placeholder="01xxxxxxxxx" autoComplete="tel" /></label>}
    {disconnected && <p className="paper-form-message">Checkout is not connected yet.</p>}
    {message && !disconnected && <p className="paper-form-message" role="alert">{message}</p>}
    <div className="paper-form-actions">
      <button type="button" className="paper-btn paper-form-submit" onClick={pay} disabled={busy || signedIn !== true}>{busy ? "Opening Paymob…" : `Pay ${formatSeasonPassPrice()}`}</button>
      <button type="button" className="paper-btn paper-demo" onClick={onDismiss}>Not now</button>
    </div>
    <p className="paper-form-switch">Paying opens Paymob. Your pass turns on only after Paymob confirms the payment.</p>
  </section>;
}
