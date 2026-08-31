"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { MiniLeagueStandingRow, MiniLeagueUiState } from "../lib/mini-league";
import { useMiniLeagueWarRoom } from "./useMiniLeagueWarRoom";

type MiniLeagueWarRoomViewProps = {
  connectedEntryId: number | null;
  leagueId: string;
  onLeagueIdChange: (value: string) => void;
  onImport: () => void;
  onPage: (page: number) => void;
  onGoToTeam: () => void;
  state: MiniLeagueUiState;
};

const errorHeadings: Record<Extract<MiniLeagueUiState, { status: "error" }>['kind'], string> = {
  invalid: "Check the league ID",
  membership: "Membership not found",
  unsupported: "Unsupported league",
  inaccessible: "League unavailable",
  timeout: "Request timed out",
  upstream: "Official data unavailable",
  unexpected: "Unexpected failure",
};

function rankMovement(change: number | null) {
  if (change === null) return "Rank change unavailable";
  if (change > 0) return `↑ ${change.toLocaleString()} place${change === 1 ? "" : "s"}`;
  if (change < 0) return `↓ ${Math.abs(change).toLocaleString()} place${change === -1 ? "" : "s"}`;
  return "No rank change";
}

function signedGap(value: number) {
  if (value > 0) return `+${value.toLocaleString()}`;
  if (value < 0) return `−${Math.abs(value).toLocaleString()}`;
  return "0";
}

function StandingsRow({ row }: { row: MiniLeagueStandingRow }) {
  return <tr className={row.isConnected ? "mini-league-user-row" : undefined} aria-current={row.isConnected ? "true" : undefined}>
    <td><b>{row.rank.toLocaleString()}</b><small>{rankMovement(row.rankChange)}</small></td>
    <td><b>{row.teamName}</b><small>{row.managerName}</small></td>
    <td>{row.gameweekPoints.toLocaleString()}</td>
    <td>{row.totalPoints.toLocaleString()}</td>
    <td className={row.pointsGap > 0 ? "ahead" : row.pointsGap < 0 ? "behind" : "level"}>{signedGap(row.pointsGap)}</td>
  </tr>;
}

export function MiniLeagueWarRoomView({
  connectedEntryId,
  leagueId,
  onLeagueIdChange,
  onImport,
  onPage,
  onGoToTeam,
  state,
}: MiniLeagueWarRoomViewProps) {
  if (connectedEntryId === null) {
    return <div className="coach-page mini-league-page">
      <section className="mini-league-connect empty-state">
        <span>MINI-LEAGUE WAR ROOM</span>
        <h2>Connect your FPL team first</h2>
        <p>The War Room reuses your existing connected team to verify league membership. It never asks for or stores a second manager identifier.</p>
        <button onClick={onGoToTeam}>Go to My team →</button>
      </section>
    </div>;
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onImport();
  };
  const result = state.status === "available" ? state.result : null;

  return <div className="coach-page mini-league-page">
    <section className="mini-league-import">
      <div>
        <span>MINI-LEAGUE WAR ROOM</span>
        <h2>Import official classic standings.</h2>
        <p>Enter the league ID from its FPL URL. Your connected team is used privately to confirm membership.</p>
      </div>
      <form onSubmit={submit}>
        <label htmlFor="mini-league-id">League ID</label>
        <div>
          <input
            id="mini-league-id"
            inputMode="numeric"
            pattern="[1-9][0-9]*"
            autoComplete="off"
            value={leagueId}
            onChange={event => onLeagueIdChange(event.target.value)}
            placeholder="e.g. 123456"
            aria-describedby="mini-league-id-help"
          />
          <button type="submit" disabled={state.status === "loading"}>Import league</button>
        </div>
        <small id="mini-league-id-help">Classic league IDs are positive whole numbers.</small>
      </form>
    </section>

    {state.status === "loading" && <section className="mini-league-status" aria-live="polite" aria-busy="true">
      <span className="live-spinner" aria-hidden="true"/><div><b>Loading official league standings…</b><small>Checking membership and locating your rank.</small></div>
    </section>}

    {state.status === "error" && <section className={`mini-league-error ${state.kind}`} aria-live="assertive">
      <span>MINI-LEAGUE STATUS</span><h2>{errorHeadings[state.kind]}</h2><p>{state.reason}</p>
    </section>}

    {result && <div aria-live="polite">
      {result.freshness.stale && <section className="mini-league-banner stale"><b>Cached official standings</b><span>FPL could not refresh this response, so the latest safe cached copy is shown.</span></section>}
      {result.seasonOver && <section className="mini-league-banner"><b>Season complete</b><span>These are final official standings for the completed season.</span></section>}
      {result.freshness.warnings.map(warning => <section className="mini-league-banner warning" key={warning}><span>{warning}</span></section>)}

      <section className="mini-league-hero">
        <header><div><span>OFFICIAL CLASSIC LEAGUE</span><h2>{result.league.name}</h2><p>Official FPL standings · League {result.league.id.toLocaleString()}</p></div><div className="mini-league-rank"><small>YOUR POSITION</small><b>Rank {result.connectedManager.rank.toLocaleString()}</b><span>{rankMovement(result.connectedManager.rankChange)}</span></div></header>
        <div className="mini-league-summary">
          <p><span>GW points</span><b>{result.connectedManager.gameweekPoints.toLocaleString()}</b></p>
          <p><span>Total points</span><b>{result.connectedManager.totalPoints.toLocaleString()}</b></p>
          <p><span>League entries</span><b>{result.connectedManager.leagueSize.toLocaleString()}</b></p>
          <p><span>Official update</span><b>{result.freshness.officialUpdatedAt ? new Date(result.freshness.officialUpdatedAt).toLocaleString() : "Unavailable"}</b></p>
        </div>
      </section>

      <section className="mini-league-table-card">
        <header><div><span>STANDINGS</span><h2>Page {result.standings.page.toLocaleString()}</h2></div><small>Points gap is relative to your total</small></header>
        {result.standings.rows.length ? <div className="mini-league-table-scroll">
          <table>
            <thead><tr><th scope="col">Rank</th><th scope="col">Team / manager</th><th scope="col">GW</th><th scope="col">Total</th><th scope="col">Gap</th></tr></thead>
            <tbody>{result.standings.rows.map(row => <StandingsRow key={row.entryId} row={row}/>)}</tbody>
          </table>
        </div> : <p className="mini-league-empty">No standings rows are available on this page.</p>}
        <footer><button onClick={() => onPage(result.standings.page - 1)} disabled={result.standings.page <= 1}>← Previous</button><span>Page {result.standings.page.toLocaleString()}</span><button onClick={() => onPage(result.standings.page + 1)} disabled={!result.standings.hasNext}>Next →</button></footer>
      </section>
    </div>}
  </div>;
}

function readConnectedEntryId(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem("fpl-edge-entry");
    if (!value || !/^[1-9]\d*$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export default function MiniLeagueWarRoom({ revision, onGoToTeam }: { revision: number; onGoToTeam: () => void }) {
  const [connectedEntryId, setConnectedEntryId] = useState<number | null>(() => readConnectedEntryId());
  useEffect(() => setConnectedEntryId(readConnectedEntryId()), [revision]);
  const warRoom = useMiniLeagueWarRoom(connectedEntryId);
  return <MiniLeagueWarRoomView
    connectedEntryId={connectedEntryId}
    leagueId={warRoom.leagueId}
    onLeagueIdChange={warRoom.setLeagueId}
    onImport={warRoom.importLeague}
    onPage={warRoom.loadPage}
    onGoToTeam={onGoToTeam}
    state={warRoom.state}
  />;
}
