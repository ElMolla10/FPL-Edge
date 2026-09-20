"use client";

import { useState } from "react";

/**
 * Personal-only: paste oidc.user JSON / refresh_token to reseed D1 without wrangler.
 * Never logs the token. Parent should force-refresh /api/fpl/team after success.
 */
export default function ReconnectFplPanel({
  onReconnected,
  errorHint,
}: {
  onReconnected?: () => void | Promise<void>;
  /** Optional liveOverlayError code for the banner. */
  errorHint?: string | null;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [ok, setOk] = useState(false);

  const submit = async () => {
    setBusy(true);
    setMessage("");
    setOk(false);
    try {
      const response = await fetch("/api/personal/fpl-auth/reconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const json = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !json.ok) {
        setMessage(
          json.error === "unauthenticated"
            ? "Sign in to reconnect FPL."
            : json.error === "not-allowlisted"
              ? "This account cannot reconnect FPL."
              : json.error === "missing-token"
                ? "Paste the oidc.user JSON or refresh_token from fantasy.premierleague.com."
                : typeof json.error === "string"
                  ? json.error
                  : "Could not save the FPL token.",
        );
        return;
      }
      setToken("");
      setOk(true);
      setMessage("FPL token saved. Refreshing live bank…");
      await onReconnected?.();
      setMessage("Live FPL reconnected. Rankings will use your live bank.");
    } catch {
      setMessage("Could not reach the reconnect API.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="reconnect-fpl-panel" aria-label="Reconnect FPL">
      <span>LIVE FPL BANK UNAVAILABLE</span>
      <h2>Live FPL bank unavailable — reconnect FPL</h2>
      <p>
        Transfers rankings are blocked until the live my-team bank is available again. Public
        history bank is not used for Actionable routes.
        {errorHint ? ` (${errorHint})` : ""}
      </p>
      <ol>
        <li>Sign in at fantasy.premierleague.com</li>
        <li>DevTools → Application → Local Storage → fantasy.premierleague.com</li>
        <li>Copy the oidc.user:… JSON (or its refresh_token)</li>
        <li>Paste below and save — do not paste into chat</li>
      </ol>
      <label>
        oidc.user JSON / refresh_token
        <textarea
          value={token}
          onChange={(e) => setToken(e.target.value)}
          rows={4}
          spellCheck={false}
          autoComplete="off"
          placeholder="Paste oidc.user JSON or refresh_token"
          disabled={busy}
        />
      </label>
      <button type="button" onClick={submit} disabled={busy || token.trim().length < 20}>
        {busy ? "Saving…" : "Reconnect FPL"}
      </button>
      {message && <p className={ok ? "reconnect-ok" : "reconnect-err"}>{message}</p>}
    </section>
  );
}
