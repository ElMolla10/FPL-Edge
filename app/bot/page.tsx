"use client";

import "../components/PaperStyles";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PaperHeader } from "../components/PaperHeader";
import type { BotStatus } from "../lib/fpl-bot/status";
import type { FplData, FplPlayer } from "../lib/fpl";
import type { DraftLabOptimizeRequest, DraftLabWorkerResponse } from "../lib/draft-lab-worker";

/**
 * Owner-only control room for the autonomous bot team: mode switch, kill switch, session age, last / next run,
 * recent decisions and errors, the bookmarklet that connects the BOT's FPL account, and a suggested starting 15.
 * Everything sensitive is enforced server-side (owner allowlist, same-origin, cron-only FPL writes).
 */

type Load = { state: "loading" } | { state: "error"; error: string } | { state: "ready"; status: BotStatus };

async function fetchStatus(): Promise<Load> {
  try {
    const response = await fetch("/api/bot/status", { cache: "no-store" });
    const json = (await response.json()) as { ok: boolean; status?: BotStatus; error?: string };
    return json.ok && json.status ? { state: "ready", status: json.status } : { state: "error", error: json.error ?? `HTTP ${response.status}` };
  } catch {
    return { state: "error", error: "network" };
  }
}

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "—");

async function post(path: string, body: unknown): Promise<{ ok: boolean; error?: string; reasons?: string[] }> {
  try {
    const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await response.json()) as { ok: boolean; error?: string; reasons?: string[] };
  } catch {
    return { ok: false, error: "network" };
  }
}

const RECONNECT_ERRORS: Record<string, string> = {
  "wrong-account": "That FPL session is NOT the bot team. Nothing was stored. Sign in as the bot (separate browser profile) and try again.",
  "identity-unverified": "FPL did not confirm which team this session belongs to. Nothing was stored.",
  "team-name-mismatch": "The bot team's public name does not match FPL_EDGE_BOT_TEAM_NAME. Nothing was stored.",
  "missing-bot-entry": "Set FPL_EDGE_BOT_FPL_ENTRY_ID first (wrangler secret put), then reconnect.",
  "bot-entry-equals-personal": "The bot entry id equals your personal entry id. Refused.",
  "missing-token-key": "Set FPL_EDGE_BOT_TOKEN_KEY first (openssl rand -base64 32), then reconnect.",
  "token-invalid": "FPL rejected that session. Sign in to FPL as the bot again, then click the bookmarklet.",
  "missing-token": "No refresh token found. Sign in to FPL as the bot first.",
  "not-owner": "This account is not a bot owner.",
  unauthenticated: "Sign in first.",
};

export default function BotPage() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => setLoad(await fetchStatus()), []);

  useEffect(() => {
    const hash = window.location.hash || "";
    const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
    const rt = params.get("bot_rt");
    const at = params.get("bot_at");
    let chain: Promise<unknown> = Promise.resolve();
    if (rt) {
      // Drop the token from the address bar / history before anything else.
      history.replaceState(null, "", window.location.pathname);
      chain = post("/api/bot/fpl-auth/reconnect", { refreshToken: rt, accessToken: at ?? "" }).then((result) =>
        setMessage(result.ok ? "Bot FPL session connected. The next hourly tick verifies identity and runs a dry run." : RECONNECT_ERRORS[result.error ?? ""] ?? `Could not connect (${result.error ?? "error"}).`),
      );
    }
    void chain.then(fetchStatus).then(setLoad);
  }, []);

  // Only rendered after the client-side status fetch resolves, so window is always defined when this is used.
  const bookmarklet = useMemo(() => {
    const base = `${typeof window === "undefined" ? "" : window.location.origin}/bot`;
    const js = `(()=>{try{var k=Object.keys(localStorage).find(function(x){return x.indexOf("oidc.user:")===0});if(!k){alert("Sign in to FPL (as the BOT) first");return;}var j=JSON.parse(localStorage.getItem(k)||"{}");if(!j.refresh_token){alert("No refresh_token in this FPL session");return;}var rt=j.refresh_token,at=j.access_token||"";localStorage.removeItem(k);Object.keys(sessionStorage).forEach(function(x){if(x.indexOf("oidc.")===0)sessionStorage.removeItem(x)});location=${JSON.stringify(base)}+"#bot_rt="+encodeURIComponent(rt)+"&bot_at="+encodeURIComponent(at);}catch(e){alert("Could not read the FPL session");}})();`;
    return `javascript:${js}`;
  }, []);

  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    const result = await post("/api/bot/control", body);
    setMessage(result.ok ? "Saved." : result.error === "live-not-ready" ? `Live is not ready: ${(result.reasons ?? []).join(", ")}` : `Refused (${result.error ?? "error"}).`);
    await refresh();
    setBusy(false);
  };

  if (load.state === "loading") return <Shell><p className="paper-note">Loading bot status…</p></Shell>;
  if (load.state === "error") {
    return (
      <Shell>
        <p className="paper-note">{load.error === "unauthenticated" ? <>Sign in first: <a href="/signin">sign in</a>.</> : load.error === "not-owner" ? "Owner only." : `Status unavailable (${load.error}).`}</p>
        {message && <p className="paper-note">{message}</p>}
      </Shell>
    );
  }
  const s = load.status;
  return (
    <Shell>
      {message && <p className="paper-note" role="status">{message}</p>}

      <section aria-label="Mode" style={{ margin: "1rem 0" }}>
        <h2 className="paper-label">Mode</h2>
        <p>
          Effective: <strong>{s.mode.effective.toUpperCase()}</strong> (requested {s.mode.requested}; page setting {s.mode.stored ?? "follow env"}; env {s.mode.env ?? "unset = shadow"})
          {s.mode.reasons.length ? ` — held back by: ${s.mode.reasons.join(", ")}` : ""}
        </p>
        <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
          <button type="button" disabled={busy} onClick={() => void act({ action: "mode", mode: "shadow" })}>Shadow (log only)</button>
          <button type="button" disabled={busy} onClick={() => void act({ action: "mode", mode: "live" })}>Go live (full control)</button>
          <button type="button" disabled={busy} onClick={() => void act({ action: "mode", mode: "off" })}>Off</button>
          <button type="button" disabled={busy} onClick={() => void act({ action: "mode", mode: "follow-env" })}>Follow env</button>
        </div>
      </section>

      <section aria-label="Kill switch" style={{ margin: "1rem 0" }}>
        <h2 className="paper-label">Kill switch</h2>
        <p>{s.safety.kill ? <strong>KILLED: {s.safety.killReason ?? "owner"}</strong> : "Not killed."} {s.safety.gwKillEvent ? `GW${s.safety.gwKillEvent} stopped: ${s.safety.gwKillReason ?? ""}` : ""}</p>
        <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
          <button type="button" disabled={busy} onClick={() => void act({ action: "kill" })}>Kill now</button>
          <button type="button" disabled={busy} onClick={() => void act({ action: "resume" })}>Resume</button>
          {s.safety.gwKillEvent ? <button type="button" disabled={busy} onClick={() => void act({ action: "clear-gw-kill" })}>Clear GW stop</button> : null}
        </div>
        <p className="paper-note">Dry run: {s.safety.dryRunPassedAt ? `passed ${when(s.safety.dryRunPassedAt)}` : "not passed yet (runs on the next hourly tick after the session is connected)"}</p>
      </section>

      <section aria-label="Bot FPL session" style={{ margin: "1rem 0" }}>
        <h2 className="paper-label">Bot FPL session</h2>
        <p>
          Bot entry: {s.config.entryConfigured ? s.config.entryId : "not set (FPL_EDGE_BOT_FPL_ENTRY_ID)"}{s.config.entryEqualsPersonal ? " — EQUALS PERSONAL ENTRY, refused" : ""}. Token key: {s.config.tokenKeyConfigured ? "set" : "missing (FPL_EDGE_BOT_TOKEN_KEY)"}.
        </p>
        <p>
          {s.session.connected ? <>Connected {when(s.session.startedAt)} · age {s.session.ageDays ?? "?"} days · ~{s.session.approxDaysLeft ?? "?"} days left · {s.session.health}</> : "Not connected."}{" "}
          Identity {s.session.identityVerified ? "verified" : "not verified"} ({when(s.session.identityCheckedAt)}). Last OK {when(s.session.lastOkAt)}{s.session.lastError ? ` · last error ${s.session.lastError}` : ""}.
        </p>
        <ol>
          <li>Open a <strong>separate browser profile / private window</strong> and sign in to fantasy.premierleague.com <strong>as the bot account</strong> (never your personal one).</li>
          <li>Close every other FPL tab in that profile, copy the bookmarklet, save it as a bookmark URL there, then click it on the FPL site.</li>
          <li>The bookmarklet hands the session to Edge and removes it from that browser, so the browser can never reuse the same refresh token (PingOne treats reuse as theft and revokes the whole session). Do not click Sign out on FPL and do not open FPL in that profile again; just close the window.</li>
          <li>You land back here signed in to Edge as the owner; the session is checked against the bot entry before anything is stored.</li>
        </ol>
        <p className="paper-note">PingOne sessions end ~30 days after the last FPL sign-in. Repeat this about every 3 weeks (status warns from day 20).</p>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(bookmarklet).then(
              () => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2500);
              },
              () => setMessage("Could not copy; long-press the link below and copy it."),
            );
          }}
        >
          {copied ? "Copied" : "Copy bot bookmarklet"}
        </button>{" "}
        <a href={bookmarklet} onClick={(e) => e.preventDefault()}>Send BOT session to Edge</a>
      </section>

      <section aria-label="Runs" style={{ margin: "1rem 0" }}>
        <h2 className="paper-label">Runs</h2>
        <p>Last tick: {when(s.lastRun.at)} — {s.lastRun.summary ?? "never"}</p>
        <p>Next: {s.nextRun ? `GW${s.nextRun.gw} deadline ${when(s.nextRun.deadline)} · now ${s.nextRun.windowNow} · next action ${when(s.nextRun.nextTickAt)} (${s.nextRun.nextTickWindow ?? "—"})` : "unknown"}</p>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>GW</th><th>Step</th><th>Status</th><th>Mode</th><th>Try</th><th>HTTP</th><th>Updated</th><th>Note</th></tr></thead>
            <tbody>
              {s.runs.map((r, i) => (
                <tr key={i}><td>{r.gw}</td><td>{r.step}</td><td>{r.status}</td><td>{r.mode ?? ""}</td><td>{r.attempt}</td><td>{r.responseStatus ?? ""}</td><td>{when(r.updatedAt)}</td><td>{r.error ?? ""}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-label="Decisions" style={{ margin: "1rem 0" }}>
        <h2 className="paper-label">Last decisions</h2>
        {s.decisions.length === 0 ? <p className="paper-note">None yet.</p> : (
          <ul className="paper-lines">
            {s.decisions.map((d, i) => {
              const sum = (d.summary ?? {}) as { transfers?: { outName: string | null; inName: string | null }[]; captain?: { name: string | null }; vice?: { name: string | null }; transferChip?: string | null; lineupChip?: string | null; hitCost?: number; reasons?: string[]; errors?: string[] };
              return (
                <li key={i}>
                  <strong>GW{d.gw} {d.step} ({d.mode})</strong> {when(d.at)} — {(sum.transfers ?? []).length ? (sum.transfers ?? []).map((t) => `${t.outName} → ${t.inName}`).join(", ") : "no transfer"}
                  {sum.transferChip ? ` · ${sum.transferChip}` : ""}{sum.lineupChip ? ` · ${sum.lineupChip}` : ""}{sum.hitCost ? ` · -${sum.hitCost}` : ""} · C {sum.captain?.name ?? "?"} / VC {sum.vice?.name ?? "?"}
                  {sum.errors?.length ? <><br /><small>blocked: {sum.errors.join("; ")}</small></> : null}
                  {sum.reasons?.length ? <><br /><small>{sum.reasons.join(" · ")}</small></> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-label="Errors" style={{ margin: "1rem 0" }}>
        <h2 className="paper-label">Recent errors and alerts</h2>
        {s.errors.length === 0 ? <p className="paper-note">None.</p> : <ul className="paper-lines">{s.errors.map((e, i) => <li key={i}>{when(e.at)} · {e.code}{e.detail ? ` — ${e.detail}` : ""}</li>)}</ul>}
      </section>

      <InitialSquad />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="paper paper-form-page">
      <PaperHeader action={{ href: "/?app=1", label: "Back to app" }} />
      <div className="paper-wrap paper-form-wrap">
        <article className="paper-form">
          <p className="paper-label">Owner only</p>
          <h1 className="paper-form-title">Bot control room</h1>
          {children}
        </article>
      </div>
    </main>
  );
}

/** Draft Lab "Build best squad" (Pure Optimum) as a suggested starting 15, to enter by hand when creating the bot team. */
function InitialSquad() {
  const [state, setState] = useState<{ busy: boolean; squad: FplPlayer[] | null; error: string }>({ busy: false, squad: null, error: "" });
  const build = async () => {
    setState({ busy: true, squad: null, error: "" });
    try {
      const response = await fetch("/api/fpl");
      if (!response.ok) throw new Error("official data unavailable");
      const data = (await response.json()) as FplData;
      const worker = new Worker(new URL("../workers/draft-lab.worker.ts", import.meta.url), { type: "module" });
      const request: DraftLabOptimizeRequest = { type: "optimize", requestId: 1, data, horizonMode: "Balanced 5 GWs", riskMode: "Balanced", philosophy: "Maximum xPts", resultMode: "Pure Optimum", squad: [], pinnedIds: [], practicalMaxChanges: 0, keepCoreMaxChanges: 0 };
      const result = await new Promise<DraftLabWorkerResponse>((resolve) => {
        worker.onmessage = (event: MessageEvent<DraftLabWorkerResponse>) => {
          if (event.data.type !== "progress") resolve(event.data);
        };
        worker.postMessage(request);
      });
      worker.terminate();
      if (result.type === "error") throw new Error(result.reason);
      if (result.type !== "result") throw new Error("no result");
      setState({ busy: false, squad: result.squad, error: "" });
    } catch (error) {
      setState({ busy: false, squad: null, error: error instanceof Error ? error.message : "failed" });
    }
  };
  const total = state.squad ? state.squad.reduce((sum, p) => sum + p.price, 0) : 0;
  return (
    <section aria-label="Suggested starting squad" style={{ margin: "1rem 0" }}>
      <h2 className="paper-label">Suggested starting 15 (Draft Lab best squad)</h2>
      <p className="paper-note">FPL has no documented API for creating a new team&apos;s first squad, so the bot does not do it. Enter these 15 by hand on fantasy.premierleague.com when you create the bot team, then set FPL_EDGE_BOT_FPL_ENTRY_ID.</p>
      <button type="button" disabled={state.busy} onClick={() => void build()}>{state.busy ? "Building…" : "Build suggested squad"}</button>
      {state.error && <p className="paper-note">Could not build: {state.error}</p>}
      {state.squad && (
        <>
          <ul className="paper-lines">
            {state.squad.map((p) => <li key={p.id}>{p.positionShort} · {p.name} ({p.teamShort}) · £{p.price.toFixed(1)}m</li>)}
          </ul>
          <p>Total £{total.toFixed(1)}m · bank £{(100 - total).toFixed(1)}m</p>
        </>
      )}
    </section>
  );
}
