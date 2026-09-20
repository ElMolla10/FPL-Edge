"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Personal-only reconnect without manual token hunting.
 * Primary path: bookmarklet on fantasy.premierleague.com posts refresh_token via #fpl_rt=.
 * Prefer Copy bookmarklet → Edit bookmark → paste URL (drag often strips javascript:).
 * Fallback: paste bare refresh_token only (never whole oidc.user JSON).
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
  const [showPaste, setShowPaste] = useState(false);
  const [copied, setCopied] = useState(false);

  const catchBase = useMemo(() => {
    if (typeof window === "undefined") return "https://fpl-edge.elmolla10.workers.dev/?app=1";
    const url = new URL(window.location.href);
    url.hash = "";
    if (!url.searchParams.has("app")) url.searchParams.set("app", "1");
    return url.toString();
  }, []);

  const bookmarklet = useMemo(() => {
    // Extracts refresh_token only and returns to Edge with #fpl_rt=…
    const js = `(()=>{try{var k=Object.keys(localStorage).find(function(x){return x.indexOf("oidc.user:")===0});if(!k){alert("Sign in to FPL first");return;}var j=JSON.parse(localStorage.getItem(k)||"{}");var rt=j&&j.refresh_token;if(!rt){alert("No refresh_token in FPL session");return;}location=${JSON.stringify(catchBase)}+"#fpl_rt="+encodeURIComponent(rt);}catch(e){alert("Could not read FPL session");}})();`;
    return `javascript:${js}`;
  }, [catchBase]);

  const copyBookmarklet = async () => {
    try {
      await navigator.clipboard.writeText(bookmarklet);
      setCopied(true);
      setMessage("Bookmarklet URL copied. Edit a bookmark and paste it into the URL field.");
      setOk(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
      setOk(false);
      setMessage("Could not copy. Select the bookmarklet link, copy manually, then paste into a bookmark URL.");
    }
  };

  const submitToken = async (raw: string) => {
    setBusy(true);
    setMessage("");
    setOk(false);
    try {
      const response = await fetch("/api/personal/fpl-auth/reconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: raw }),
      });
      const json = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !json.ok) {
        setMessage(
          json.error === "unauthenticated"
            ? "Sign in to reconnect FPL."
            : json.error === "not-allowlisted"
              ? "This account cannot reconnect FPL."
              : json.error === "missing-token"
                ? "Could not find a refresh_token. Use the bookmarklet after signing in to FPL."
                : json.error === "token-invalid"
                  ? "That FPL session was rejected. Sign in to FPL again, then click the bookmarklet."
                  : typeof json.error === "string"
                    ? json.error
                    : "Could not save the FPL token.",
        );
        return false;
      }
      setToken("");
      setOk(true);
      setMessage("FPL session saved. Refreshing live bank…");
      await onReconnected?.();
      setMessage("Live FPL reconnected. Rankings will use your live bank.");
      return true;
    } catch {
      setMessage("Could not reach the reconnect API.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash || "";
    const match = hash.match(/^#fpl_rt=(.+)$/);
    if (!match) return;
    const raw = decodeURIComponent(match[1]);
    history.replaceState(null, "", window.location.pathname + window.location.search);
    void submitToken(raw);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot hash capture
  }, []);

  return (
    <section className="reconnect-fpl-panel" aria-label="Reconnect FPL">
      <span>LIVE FPL BANK UNAVAILABLE</span>
      <h2>Live FPL bank unavailable — reconnect FPL</h2>
      <p>
        Transfers rankings are blocked until the live my-team bank is available again. Public
        history bank is not used for Actionable routes.
        {errorHint ? ` (${errorHint})` : ""}
      </p>
      <p>
        PingOne sessions last about 30 days from the last FPL sign-in (refresh does not extend
        that). After expiry, reconnect once with the bookmarklet — no manual token hunting.
      </p>

      <div className="reconnect-primary">
        <button type="button" onClick={() => void copyBookmarklet()} disabled={busy}>
          {copied ? "Copied" : "Copy bookmarklet"}
        </button>
        <a href={bookmarklet} onClick={(e) => e.preventDefault()} className="reconnect-bookmark-link">
          Send FPL session to Edge
        </a>
      </div>

      <ol>
        <li>
          <strong>Preferred:</strong> tap <strong>Copy bookmarklet</strong>, then create or edit a
          bookmark and paste the full <code>javascript:…</code> URL into the bookmark&apos;s URL
          field (Chrome: Bookmarks → Bookmark manager → ⋮ → Edit; Safari: Bookmarks → Edit
          Bookmarks → select bookmark → paste URL). Dragging often strips <code>javascript:</code>.
        </li>
        <li>
          Open{" "}
          <a href="https://fantasy.premierleague.com" target="_blank" rel="noreferrer">
            fantasy.premierleague.com
          </a>{" "}
          and sign in
        </li>
        <li>Click the bookmark — you return here and the live bank reconnects automatically</li>
      </ol>

      <p className="reconnect-hint">
        If clicking the bookmark on FPL does nothing (no alert, no redirect), the bookmark is not a{" "}
        <code>javascript:</code> bookmark — browsers often strip that scheme when dragging. Use{" "}
        <strong>Copy bookmarklet</strong> and paste into Edit bookmark → URL, then try again. Mobile
        Safari may block bookmarklets entirely; use Advanced paste below on desktop.
      </p>

      <button
        type="button"
        className="reconnect-secondary"
        onClick={() => setShowPaste((v) => !v)}
        disabled={busy}
      >
        {showPaste ? "Hide advanced paste" : "Advanced: paste refresh_token only"}
      </button>
      {showPaste && (
        <>
          <p>
            Paste the bare <code>refresh_token</code> value only — not the whole oidc.user JSON
            (Worker secrets truncate near 5 KB).
          </p>
          <label>
            refresh_token
            <textarea
              value={token}
              onChange={(e) => setToken(e.target.value)}
              rows={3}
              spellCheck={false}
              autoComplete="off"
              placeholder="Paste refresh_token only"
              disabled={busy}
            />
          </label>
          <button type="button" onClick={() => void submitToken(token)} disabled={busy || token.trim().length < 20}>
            {busy ? "Saving…" : "Reconnect FPL"}
          </button>
        </>
      )}
      {message && <p className={ok ? "reconnect-ok" : "reconnect-err"}>{message}</p>}
    </section>
  );
}
