// "Tonight" price sheet. Reads ONLY FPL's own first-party price_change_projections (priceOutlook,
// offset 0/1/2) -- no in-house price model. Rows are limited to the manager's own XV plus the
// canonical weekly decision's OUT/IN; the wider market is never listed.
import type { FplPlayer } from "./fpl";

/** Noise floor for "meaningful" pressure (shared with Transfers' price intel). */
export const MEANINGFUL_PRICE_PRESSURE = 15;
/** Bar for the one-line Home teaser. */
export const PRICE_TEASER_PRESSURE = 50;

export type PriceDirection = "rise" | "fall" | "stable";
export type PriceSheetDay = { offsetDays: number; label: string; pct: number; direction: PriceDirection };
export type PriceSheetRole = "owned" | "out" | "in";
export type PriceSheetRow = { player: FplPlayer; role: PriceSheetRole; todayPct: number; days: PriceSheetDay[] };
export type PriceSheet = { rows: PriceSheetRow[]; teaser: string | null };

export const priceDayLabel = (offsetDays: number) => (offsetDays === 0 ? "Today" : offsetDays === 1 ? "Tomorrow" : "Day after");

/** FPL's 3-day outlook, sorted. A day whose likelihood sign disagrees with its percent reads as 0 (defensive, same as priceOutlookSignal). */
export function priceSheetDays(player: FplPlayer): PriceSheetDay[] {
  const raw = Array.isArray(player.priceOutlook) ? player.priceOutlook : [];
  return [...raw]
    .sort((a, b) => a.offsetDays - b.offsetDays)
    .map(d => {
      const disagree = d.projectedPercent !== 0 && d.likelihood !== 0 && Math.sign(d.likelihood) !== Math.sign(d.projectedPercent);
      const pct = disagree ? 0 : Math.round(d.projectedPercent);
      const direction: PriceDirection = pct >= MEANINGFUL_PRICE_PRESSURE ? "rise" : pct <= -MEANINGFUL_PRICE_PRESSURE ? "fall" : "stable";
      return { offsetDays: d.offsetDays, label: priceDayLabel(d.offsetDays), pct, direction };
    });
}

const todayOf = (p: FplPlayer, days: PriceSheetDay[]) => days.find(d => d.offsetDays === 0)?.pct ?? Math.round(p.priceProjectionToday ?? 0);

export function buildPriceSheet(input: {
  squad: readonly FplPlayer[];
  players: readonly FplPlayer[];
  outPlayerId?: number | null;
  inPlayerId?: number | null;
}): PriceSheet {
  const ownedIds = new Set(input.squad.map(p => p.id));
  const rows: PriceSheetRow[] = [];
  const inPlayer = input.inPlayerId != null && !ownedIds.has(input.inPlayerId) ? input.players.find(p => p.id === input.inPlayerId) ?? null : null;
  if (inPlayer) { const days = priceSheetDays(inPlayer); rows.push({ player: inPlayer, role: "in", todayPct: todayOf(inPlayer, days), days }); }
  const owned: PriceSheetRow[] = [];
  for (const p of input.squad) {
    const days = priceSheetDays(p);
    const isOut = p.id === input.outPlayerId;
    if (!isOut && !days.some(d => d.direction === "fall")) continue;
    owned.push({ player: p, role: isOut ? "out" : "owned", todayPct: todayOf(p, days), days });
  }
  owned.sort((a, b) => (a.role === "out" ? -1 : b.role === "out" ? 1 : a.todayPct - b.todayPct));
  rows.push(...owned);

  const falling = input.squad.filter(p => todayOf(p, priceSheetDays(p)) <= -PRICE_TEASER_PRESSURE);
  const inRising = inPlayer && rows[0].todayPct >= PRICE_TEASER_PRESSURE;
  let teaser: string | null = null;
  if (falling.length) teaser = `${falling[0].name}${falling.length > 1 ? ` +${falling.length - 1}` : ""} could drop tonight`;
  if (inRising) teaser = teaser ? `${teaser} · ${inPlayer.name} could rise` : `${inPlayer.name} could rise tonight`;
  return { rows, teaser };
}
