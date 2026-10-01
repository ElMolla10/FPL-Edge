// Weekly close: a read-only summary of the canonical decision (same object Home/Transfers/Coach read)
// that the manager executes on official FPL themselves. Nothing here places a transfer.
import type { WeeklyDecision } from "./weekly-decision";
import { formatHit, formatNet } from "./weekly-decision";

export const FPL_TRANSFERS_URL = "https://fantasy.premierleague.com/transfers";
export const FPL_MY_TEAM_URL = "https://fantasy.premierleague.com/my-team";

type Named = { id: number; name: string };
export type ExecuteSummary = {
  gameweek: number;
  formation: string;
  captain: string;
  vice: string;
  move: { action: "HOLD" } | { action: "MAKE"; out: string; in: string; hit: string; net5gw: string };
  bankAfter: number;
  chip: string | null;
  checklist: string[];
  shareText: string;
  fplUrl: string;
};

export function buildExecuteSummary(input: {
  decision: WeeklyDecision;
  formation: string;
  xi: readonly Named[];
  bench: readonly Named[];
  captain: Named;
  vice: Named;
  chip: string | null;
}): ExecuteSummary {
  const d = input.decision;
  const make = d.action === "MAKE" && d.outName && d.inName;
  const bankAfter = Math.round(((make ? d.row?.bankAfter : undefined) ?? d.bank) * 10) / 10;
  const move: ExecuteSummary["move"] = make
    ? { action: "MAKE", out: d.outName!, in: d.inName!, hit: formatHit(d), net5gw: formatNet(d.net5gw) }
    : { action: "HOLD" };
  const checklist = [
    make ? `Transfer: ${d.outName} OUT → ${d.inName} IN (${formatHit(d)}, bank after £${bankAfter.toFixed(1)}m)` : `Transfers: none — save the free transfer`,
    `Starting XI (${input.formation}): ${input.xi.map(p => p.name).join(", ")}`,
    `Bench in order: ${input.bench.map(p => p.name).join(", ")}`,
    `Captain: ${input.captain.name} · Vice: ${input.vice.name}`,
    `Chip: ${input.chip ?? "none"}`,
  ];
  const shareText = `GW${d.gameweek} on FPL Edge: ${make ? `${d.outName} → ${d.inName} (${formatNet(d.net5gw)} over 5 GWs)` : "holding the transfer"}, ${input.captain.name} (C), ${input.vice.name} (VC), ${input.formation}${input.chip ? `, playing ${input.chip}` : ", no chip"}.`;
  return { gameweek: d.gameweek, formation: input.formation, captain: input.captain.name, vice: input.vice.name, move, bankAfter, chip: input.chip, checklist, shareText, fplUrl: make ? FPL_TRANSFERS_URL : FPL_MY_TEAM_URL };
}

/** Official FPL has no URL that pre-selects players; this only opens the page. No params, ever. */
export const DEMO_COPY_PREFIX = "Example squad — not your FPL team.";
export type FplMoveLink = {
  make: boolean;
  label: "Make this on FPL" | "Open FPL";
  href: typeof FPL_TRANSFERS_URL;
  move: { out: string; in: string; price: number; bankAfter: number; hit: string } | null;
  copyText: string;
};
export function buildFplMoveLink(d: WeeklyDecision, captainName: string | null, demo: boolean): FplMoveLink {
  const make = d.action === "MAKE" && !!d.outName && !!d.inName;
  const bankAfter = Math.round(((make ? d.row?.bankAfter : undefined) ?? d.bank) * 10) / 10;
  const move = make ? { out: d.outName!, in: d.inName!, price: d.row?.incoming?.price ?? 0, bankAfter, hit: d.hitCost > 0 ? `−${d.hitCost} hit` : "Free" } : null;
  const cap = captainName ? ` Then set captain ${captainName} on Pick Team.` : "";
  const body = make ? `GW${d.gameweek}: sell ${move!.out}, buy ${move!.in}.${cap}` : `GW${d.gameweek}: no transfer this week.${cap}`;
  return { make, label: make ? "Make this on FPL" : "Open FPL", href: FPL_TRANSFERS_URL, move, copyText: demo ? `${DEMO_COPY_PREFIX} ${body}` : body };
}
