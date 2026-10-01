"use client";
import { useState } from "react";
import type { WeeklyDecision } from "../lib/weekly-decision";
import { buildFplMoveLink, FPL_MY_TEAM_URL } from "../lib/execute-summary";
import { isExampleSquadActive } from "../lib/example-squad";

/** Opens official FPL in a new tab. Read-only: never places a transfer, never sends credentials. */
export function FplMoveLink({ decision, captainName, variant = "primary" }: { decision: WeeklyDecision; captainName: string | null; variant?: "primary" | "secondary" }) {
  const [copied, setCopied] = useState(false);
  const l = buildFplMoveLink(decision, captainName, isExampleSquadActive());
  const copy = async () => { try { await navigator.clipboard.writeText(l.copyText); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { /* clipboard blocked */ } };
  return <div className={`fpl-move-link fpl-move-link-${variant}`} data-testid="fpl-move-link">
    <a className="fpl-move-cta" href={l.href} target="_blank" rel="noopener noreferrer">{l.label} ↗</a>
    {l.move && <span className="fpl-move-detail"><b>{l.move.out} → {l.move.in}</b> · £{l.move.price.toFixed(1)}m · bank after £{l.move.bankAfter.toFixed(1)}m · {l.move.hit}</span>}
    <button type="button" className="fpl-move-copy" onClick={copy}>{copied ? "Copied ✓" : "Copy move"}</button>
    <a className="fpl-move-pick" href={FPL_MY_TEAM_URL} target="_blank" rel="noopener noreferrer">Open Pick Team ↗</a>
  </div>;
}
