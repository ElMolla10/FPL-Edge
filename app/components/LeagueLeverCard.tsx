"use client";

import { useEffect, useMemo, useState } from "react";
import { bestXi, futureEvents, playerProjection, savedSquad, type FplData } from "../lib/fpl";
import { isExampleSquadActive } from "../lib/example-squad";
import { computeLeagueLever } from "../lib/league-lever";
import type { RivalPicksResult } from "../lib/mini-league-server";

type State = { status: "loading" } | { status: "error"; reason: string } | { status: "ready"; result: RivalPicksResult };

/** "What moves me vs MY rivals this GW": league-local ownership vs your canonical squad. Never crashes the desk. */
export function LeagueLeverCard({ data, leagueId, entryId, leagueName }: { data: FplData; leagueId: number; entryId: number; leagueName: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  useEffect(() => {
    let live = true;
    fetch(`/api/fpl/league/rivals?league=${leagueId}&entry=${entryId}`)
      .then(async r => { const body = await r.json().catch(() => null); if (!r.ok || !body || !Array.isArray(body.rivals)) throw new Error(body?.error || "Official FPL rival picks are unavailable right now."); return body as RivalPicksResult; })
      .then(result => { if (live) setState({ status: "ready", result }); })
      .catch(e => { if (live) setState({ status: "error", reason: e instanceof Error ? e.message : "Official FPL rival picks are unavailable right now." }); });
    return () => { live = false; };
  }, [leagueId, entryId]);

  const gw = futureEvents(data, 1)[0]?.id ?? data.events.find(e => e.current)?.id ?? 1;
  const squad = useMemo(() => savedSquad(data), [data]);
  const byId = useMemo(() => new Map(data.players.map(p => [p.id, p])), [data]);
  const lever = useMemo(() => {
    if (state.status !== "ready" || squad.length !== 15) return null;
    const xi = bestXi(squad, gw, data.fixtures, gw);
    const proj = (id: number) => { const p = byId.get(id); return p ? playerProjection(p, gw, data.fixtures, gw) : 0; };
    return computeLeagueLever({ xiIds: xi.players.map(p => p.id), benchIds: squad.filter(p => !xi.players.some(x => x.id === p.id)).map(p => p.id), captainId: xi.captain?.id ?? xi.players[0]?.id ?? 0, rivals: state.result.rivals, projection: proj });
  }, [state, squad, gw, data, byId]);

  if (state.status === "loading") return <section className="league-lever" aria-busy="true"><span>THIS WEEK IN YOUR LEAGUE</span><p>Reading rivals&apos; public picks…</p></section>;
  if (state.status === "error") return <section className="league-lever error" role="status"><span>THIS WEEK IN YOUR LEAGUE</span><h2>Rival picks unavailable</h2><p>{state.reason} Standings above are unaffected.</p></section>;
  if (!lever) return <section className="league-lever"><span>THIS WEEK IN YOUR LEAGUE</span><p>Save a full 15 to compare it with your rivals.</p></section>;
  const name = (id: number) => byId.get(id)?.name ?? `Player ${id}`;
  const r = state.result;
  return <section className="league-lever" aria-label="Your lever in this league">
    <span>THIS WEEK IN {leagueName.toUpperCase()}</span>
    {lever.lever ? <h2>{lever.lever.kind === "yours"
      ? <>Your lever: <b>{name(lever.lever.playerId)}</b> — you start him, only {lever.lever.rivalOwnPct}% of your rivals own him.</>
      : <>Your threat: <b>{name(lever.lever.playerId)}</b> — {lever.lever.rivalOwnPct}% of your rivals own him, you don&apos;t start him.</>}</h2>
      : <h2>No single player separates you from your rivals this week.</h2>}
    <div className="league-lever-score">
      <p><small>YOUR GW{gw} PROJECTION</small><b>{lever.userProjection.toFixed(1)}</b></p>
      <p><small>RIVALS&apos; AVERAGE</small><b>{lever.leagueAverageProjection.toFixed(1)}</b></p>
    </div>
    {lever.captains.length > 0 && <table className="league-lever-captains"><caption>Who your rivals captain</caption><tbody>{lever.captains.map(c => <tr key={c.playerId}><td>{name(c.playerId)}</td><td>{c.pct}%</td></tr>)}</tbody></table>}
    <small className="league-lever-note">Based on {r.sampled} rival{r.sampled === 1 ? "" : "s"} (top 10 + 5 either side of you, max {r.cap}) of {r.leagueSize.toLocaleString()} · their public GW{r.event} teams — FPL keeps next week&apos;s picks private until the deadline.{r.failed ? ` ${r.failed} couldn't be read.` : ""}</small>
  </section>;
}

export function leagueLeverBlockedReason(): string | null {
  return isExampleSquadActive() ? "The demo squad isn't in a real league. Connect your own FPL team to see your lever against real rivals." : null;
}
