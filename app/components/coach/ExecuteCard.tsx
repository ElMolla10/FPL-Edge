"use client";
import { useState } from "react";
import type { FplPlayer } from "../../lib/fpl";
import type { WeeklyDecision } from "../../lib/weekly-decision";
import { buildExecuteSummary } from "../../lib/execute-summary";
import type { View } from "./CoachCore";
import { FplMoveLink } from "../FplMoveLink";

/** Weekly close: read-only. The manager makes these changes on official FPL themselves. */
export function ExecuteCard({ decision, pending, formation, xi, bench, captain, vice, chip, lockedGw, onLock, go }: {
  decision: WeeklyDecision | null; pending: boolean; formation: string; xi: FplPlayer[]; bench: FplPlayer[];
  captain: FplPlayer; vice: FplPlayer; chip: string | null; lockedGw: number | null; onLock: () => void; go: (v: View) => void;
}) {
  const [copied, setCopied] = useState<"" | "list" | "share">("");
  if (!decision) return <section className="execute-card"><span>THIS WEEK&apos;S CLOSE</span><p>{pending ? "Calculating this week's call…" : "Connect your bank and team to see this week's call."}</p></section>;
  const s = buildExecuteSummary({ decision, formation, xi, bench, captain, vice, chip });
  const copy = async (kind: "list" | "share", text: string) => { try { await navigator.clipboard.writeText(text); setCopied(kind); window.setTimeout(() => setCopied(""), 2000); } catch { /* clipboard blocked */ } };
  return <section className="execute-card" data-testid="execute-card">
    <header><span>GW{s.gameweek} · THIS WEEK&apos;S CLOSE</span>{lockedGw === s.gameweek && <b className="execute-locked">Locked for GW{s.gameweek}</b>}</header>
    <div className="execute-grid">
      <article><span>CALL</span>{s.move.action === "MAKE" ? <><b>{s.move.out} → {s.move.in}</b><small>{s.move.hit} · {s.move.net5gw} 5-GW NET</small></> : <><b>HOLD</b><small>Save the free transfer</small></>}</article>
      <article><span>BANK AFTER</span><b>£{s.bankAfter.toFixed(1)}m</b></article>
      <article><span>XI</span><b>{s.formation}</b></article>
      <article><span>CAPTAIN / VICE</span><b>{s.captain}</b><small>Vice: {s.vice}</small></article>
      <article><span>CHIP</span><b>{s.chip ?? "None"}</b></article>
    </div>
    <FplMoveLink decision={decision} captainName={captain.name}/>
    <div className="execute-checklist"><span>MAKE THIS ON OFFICIAL FPL YOURSELF</span><ol>{s.checklist.map(line => <li key={line}>{line}</li>)}</ol></div>
    <div className="execute-actions">
      <button type="button" className="lock-button" onClick={onLock}>{lockedGw === s.gameweek ? `LOCKED FOR GW${s.gameweek} ✓ · RE-LOCK` : "LOCK THIS TEAM"}</button>
      <button type="button" className="execute-copy" onClick={() => copy("list", s.checklist.join("\n"))}>{copied === "list" ? "Copied ✓" : "Copy checklist"}</button>
      <button type="button" className="execute-copy" onClick={() => copy("share", s.shareText)}>{copied === "share" ? "Copied ✓" : "Copy share text"}</button>
      {s.move.action === "MAKE" && <button type="button" className="execute-copy" onClick={() => go("transfers")}>See the full breakdown</button>}
    </div>
    <p className="execute-share">{s.shareText}</p>
  </section>;
}
