"use client";
import { useMemo } from "react";
import { FplData, savedSquad } from "../../lib/fpl";
import { buildPriceSheet } from "../../lib/price-sheet";
import { useManager, useWeeklyDecision } from "./CoachCore";
import type { View } from "./CoachCore";

const ROLE_LABEL = { owned: "In your XV", out: "This week's OUT", in: "This week's IN" } as const;
const pctText = (pct: number) => (pct === 0 ? "0%" : `${pct > 0 ? "+" : "−"}${Math.abs(pct)}%`);

export function PriceSheet({ data, go, revision }: { data: FplData; go: (v: View) => void; revision: number }) {
  const [meta] = useManager(revision);
  const squad = useMemo(() => savedSquad(data), [data, revision, meta]);
  const weekly = useWeeklyDecision(data, squad, meta);
  const wd = weekly.status === "ready" ? weekly.decision : null;
  const make = wd?.action === "MAKE";
  const sheet = buildPriceSheet({ squad, players: data.players, outPlayerId: make ? wd?.outPlayerId : null, inPlayerId: make ? wd?.inPlayerId : null });

  return <div className="coach-page price-sheet">
    <header className="price-sheet-head">
      <span>TONIGHT</span>
      <h1>Price sheet</h1>
      <p>FPL&apos;s own price projection for your XV{make ? " and this week's move" : ""}. A move is £0.1m.</p>
    </header>
    {!squad.length ? <p className="price-sheet-empty">Connect a team or open the demo to see your price sheet.</p>
      : !sheet.rows.length ? <p className="price-sheet-empty">No meaningful price risk on your XV tonight.</p>
      : <div className="price-sheet-rows">{sheet.rows.map(r => <article key={r.player.id} className={`price-sheet-row ${r.role}`}>
          <div><small>{ROLE_LABEL[r.role]}</small><b>{r.player.name}</b><em>£{r.player.price.toFixed(1)}m</em></div>
          <strong className={r.todayPct >= 15 ? "rise" : r.todayPct <= -15 ? "fall" : "stable"}>{pctText(r.todayPct)}<small>today</small></strong>
          <ol aria-label="Next three days">{r.days.map(d => <li key={d.offsetDays} className={d.direction}><small>{d.label}</small>{pctText(d.pct)}</li>)}</ol>
        </article>)}</div>}
    <p className="price-sheet-note">{make ? "This week's transfer is the call on points — price is not the reason for it." : "Don't take a hit just to dodge a £0.1m drop. This week's call is unchanged."}</p>
    <button type="button" className="price-sheet-back" onClick={() => go(make ? "transfers" : "overview")}>{make ? "Open Transfers →" : "Back to Home →"}</button>
  </div>;
}
