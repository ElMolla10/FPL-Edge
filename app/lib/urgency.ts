import type { FplPlayer } from "./fpl";

/** One start-probability threshold for Home URGENT and pitch LIKELY/RISK labels. */
export const START_RISK_THRESHOLD = 50;

export type RiskLabel = "LIKELY" | "RISK" | "FLAGGED";
export const isOfficialFlag = (p: Pick<FplPlayer, "status">) => p.status !== "a";
export function riskLabel(p: Pick<FplPlayer, "status">, startPct: number): RiskLabel {
  if (isOfficialFlag(p)) return "FLAGGED";
  return startPct < START_RISK_THRESHOLD ? "RISK" : "LIKELY";
}

export type UrgentItem = { player: FplPlayer; level: "URGENT" | "MONITOR"; reason: string };

/** URGENT only when it changes this week's points; everything else is MONITOR. */
export function classifyUrgency(input: { xi: FplPlayer[]; bench: FplPlayer[]; startPct: (p: FplPlayer) => number; target?: FplPlayer | null }): { urgent: UrgentItem[]; monitor: UrgentItem[] } {
  const { xi, bench, startPct, target } = input;
  const urgent: UrgentItem[] = [];
  const monitor: UrgentItem[] = [];
  for (const p of xi) {
    const label = riskLabel(p, startPct(p));
    if (label === "FLAGGED") urgent.push({ player: p, level: "URGENT", reason: "Official flag on a starter" });
    else if (label === "RISK") urgent.push({ player: p, level: "URGENT", reason: `${startPct(p)}% start chance — starter` });
  }
  const xiRisk = urgent.length > 0;
  const b1 = bench[0];
  if (b1) {
    const label = riskLabel(b1, startPct(b1));
    if (label === "FLAGGED") urgent.push({ player: b1, level: "URGENT", reason: "Official flag on first sub" });
    else if (label === "RISK") (xiRisk ? urgent : monitor).push({ player: b1, level: xiRisk ? "URGENT" : "MONITOR", reason: `${startPct(b1)}% start chance — first sub${xiRisk ? " needed for autosub" : ""}` });
  }
  for (const p of bench.slice(1)) {
    if (riskLabel(p, startPct(p)) !== "LIKELY") monitor.push({ player: p, level: "MONITOR", reason: `${startPct(p)}% start chance — bench` });
  }
  if (target && isOfficialFlag(target) && !urgent.some(u => u.player.id === target.id)) {
    urgent.push({ player: target, level: "URGENT", reason: "Recommended transfer target just got flagged" });
  }
  return { urgent, monitor };
}
