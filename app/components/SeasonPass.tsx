"use client";

import { useState } from "react";
import { formatSeasonPassPrice } from "../lib/season-pass";

// Clicking pay only starts a Paymob intention. Nothing in this file writes an "unlocked" flag.
// The desk stays gated until /api/auth/me reports an active pass from the verified callback.

export function SeasonLocked({ feature, onUpgrade }: { feature: string; onUpgrade: () => void }) {
  return <section className="season-locked">
    <span>SEASON PASS</span>
    <h2>{feature}</h2>
    <p>Free covers one active team, the current gameweek projection, the lineup and captain recommendation, and one transfer scenario. The season pass is {formatSeasonPassPrice()} for the rest of this FPL season — not a monthly plan.</p>
    <button type="button" onClick={onUpgrade}>Upgrade for {formatSeasonPassPrice()}</button>
  </section>;
}

export function SeasonUpgrade({ checkoutReturn, onDismiss }: { checkoutReturn?: boolean; onDismiss: () => void }) {
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [disconnected, setDisconnected] = useState(false);

  const pay = async () => {
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

  return <section className="season-upgrade">
    <span>SEASON PASS · {formatSeasonPassPrice()}</span>
    <h2>Your full decision desk, for the rest of this season.</h2>
    <p>Multi-week transfer planning, safe and aggressive alternatives, news impact alerts, draft and chip optimization, and decision history. Paying sends you to Paymob. Access turns on only after Paymob's verified callback — this page cannot mark the pass active.</p>
    {checkoutReturn && <p className="season-note">You are back from Paymob. If the payment succeeded, refresh in a moment. This return does not unlock the desk by itself.</p>}
    <label>Egyptian mobile<input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" placeholder="01xxxxxxxxx" autoComplete="tel" /></label>
    <div className="season-upgrade-actions">
      <button type="button" onClick={pay} disabled={busy}>{busy ? "Opening Paymob…" : `Pay ${formatSeasonPassPrice()}`}</button>
      <button type="button" className="season-dismiss" onClick={onDismiss}>Not now</button>
    </div>
    {disconnected && <p className="season-note">Checkout is not connected yet.</p>}
    {message && !disconnected && <p className="season-note">{message}</p>}
  </section>;
}
