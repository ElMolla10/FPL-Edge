// One canonical weekly call. Home (Overview), Transfers and Coach ("What transfer should I make?")
// all read this object, so they cannot disagree on HOLD vs MAKE, OUT → IN, or 5-GW NET.
//
// No new scoring rule lives here: the action is whatever selectBestDecision() picks from the rows
// produced by the Transfers BEST DECISION pipeline (rankTransfersForBestDecision: deep bestTransfers
// limit 60 + model utility). This file only packages that row into stable fields and formats them.

import { compareTransferToHold, selectBestDecision, type Transfer } from "./transfers";

export const WEEKLY_DECISION_SOURCE = "transfers-best-decision" as const;

export type WeeklyDecisionAction = "HOLD" | "MAKE";
export type FreeTransferSource = "live" | "assumed";

export type WeeklyDecision = {
  gameweek: number;
  action: WeeklyDecisionAction;
  /** Engine badge (MAKE / LEAN for moves, HOLD / KEEP for no move). Display only. */
  classification: string;
  outPlayerId: number | null;
  inPlayerId: number | null;
  outName: string | null;
  inName: string | null;
  captainId: number | null;
  hitCost: number;
  net3gw: number;
  net5gw: number;
  riskAdjustedNet5gw: number;
  immediateNet: number;
  /** Engine confidence in the incoming player (0–1); null on HOLD. */
  confidence: number | null;
  risk: "Low" | "Medium" | "High" | null;
  why: string;
  source: typeof WEEKLY_DECISION_SOURCE;
  freeTransfers: number;
  freeTransferSource: FreeTransferSource;
  bank: number;
  wildcardActive: boolean;
  /** The engine row this decision was taken from (null when the engine returned nothing). */
  row: Transfer | null;
};

export type WeeklyDecisionContext = {
  gameweek: number;
  freeTransfers: number;
  freeTransferSource: FreeTransferSource;
  bank: number;
  captainId: number | null;
  wildcardActive?: boolean;
};

const finite = (n: number | undefined | null): number => (typeof n === "number" && Number.isFinite(n) ? n : 0);

/** Pure: same rows + same context → same decision. */
export function buildWeeklyDecision(rows: Transfer[], ctx: WeeklyDecisionContext): WeeklyDecision {
  const wildcardActive = ctx.wildcardActive === true;
  const row = selectBestDecision(rows);
  const hold = !row || row.isHold === true || row.classification === "HOLD";
  const base = {
    gameweek: ctx.gameweek,
    captainId: ctx.captainId,
    source: WEEKLY_DECISION_SOURCE,
    freeTransfers: ctx.freeTransfers,
    freeTransferSource: ctx.freeTransferSource,
    bank: ctx.bank,
    wildcardActive,
    row,
  };
  if (hold) {
    return {
      ...base,
      action: "HOLD",
      classification: wildcardActive ? "KEEP" : "HOLD",
      outPlayerId: null,
      inPlayerId: null,
      outName: null,
      inName: null,
      hitCost: 0,
      net3gw: 0,
      net5gw: 0,
      riskAdjustedNet5gw: 0,
      immediateNet: 0,
      confidence: null,
      risk: null,
      why: row?.engineReason
        ?? (wildcardActive
          ? "Wildcard KEEP: no swap clears the full-squad bar; unlimited changes remain until the deadline."
          : "Type-B HOLD: no transfer now; future free transfers stay available."),
    };
  }
  const cmp = compareTransferToHold(row);
  return {
    ...base,
    action: "MAKE",
    classification: row.classification ?? "MAKE",
    outPlayerId: row.out.id,
    inPlayerId: row.incoming.id,
    outName: row.out.name,
    inName: row.incoming.name,
    hitCost: finite(row.hitCost),
    net3gw: finite(row.threeGwNetVsHold ?? row.netEv3),
    net5gw: finite(cmp.fiveGwNetVsHold),
    riskAdjustedNet5gw: finite(cmp.riskAdjustedFiveGwNetVsHold),
    immediateNet: finite(cmp.thisGwVsHold),
    confidence: Number.isFinite(row.confidenceIn) ? row.confidenceIn : null,
    risk: row.risk ?? null,
    why: row.engineReason ?? `${row.out.name} → ${row.incoming.name} clears the risk-adjusted 5-GW NET vs HOLD bar.`,
  };
}

/** The ONLY rounding used for decision NETs on every surface: signed, one decimal ("+9.2", "−" uses "-"). */
export function formatNet(value: number): string {
  const rounded = Math.round(finite(value) * 10) / 10;
  const safe = Object.is(rounded, -0) ? 0 : rounded;
  return `${safe >= 0 ? "+" : ""}${safe.toFixed(1)}`;
}

/** Hit label shared by all surfaces. */
export function formatHit(decision: WeeklyDecision): string {
  if (decision.wildcardActive) return "Wildcard";
  if (decision.action === "HOLD") return "Free";
  return decision.row?.hitLabel ?? (decision.hitCost ? `−${decision.hitCost}` : "Free");
}

/** Coach answer for "What transfer should I make?" — prints the same action + net5gw as Transfers. */
export function narrateWeeklyDecision(decision: WeeklyDecision): string {
  const ft = decision.freeTransferSource === "assumed" ? ` (FT assumed: ${decision.freeTransfers})` : "";
  if (decision.action === "HOLD") {
    return `HOLD — no transfer this week. No move clears the risk-adjusted 5-GW NET vs HOLD bar${ft}. ${decision.why}`;
  }
  return `MAKE — ${decision.outName} → ${decision.inName}: ${formatNet(decision.net5gw)} 5-GW NET vs HOLD (hit ${formatHit(decision)})${ft}. ${decision.why}`;
}
