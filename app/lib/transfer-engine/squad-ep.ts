import {
  FplData,
  FplPlayer,
  futureEvents,
  playerProjection,
} from "../fpl";
import type { TransferEngineRules } from "./rules";
import { DEFAULT_TRANSFER_RULES_2026_27 } from "./rules";
import type { HoldBaseline, SquadWeekLineup, TeamState } from "./types";
import { clampFreeTransfers, freeTransfersAfterDeadline } from "./rules";

const money = (value: number) => Math.round((value + Number.EPSILON) * 10) / 10;

/**
 * Optimal XI + captain + vice for one gameweek.
 * Points = XI sum + captain xPts (standard 2× via +captain once more).
 * Vice is selected for state/display but does NOT add points (no double-count).
 * Bench Boost / Triple Captain are intentionally excluded — chips are separate.
 */
export function optimalSquadWeek(
  squad: FplPlayer[],
  eventId: number,
  data: FplData,
  firstEvent: number,
  project: (player: FplPlayer, eventId: number) => number = (p, e) =>
    playerProjection(p, e, data.fixtures, firstEvent),
): SquadWeekLineup {
  const score = (p: FplPlayer) => project(p, eventId);
  let best: SquadWeekLineup = {
    eventId,
    xi: [],
    captain: null,
    vice: null,
    bench: [...squad],
    grossEp: 0,
  };
  const keepers = squad.filter((p) => p.positionShort === "GKP").sort((a, b) => score(b) - score(a));
  if (!keepers.length) return best;

  for (let def = 3; def <= 5; def++) {
    for (let mid = 2; mid <= 5; mid++) {
      const fwd = 10 - def - mid;
      if (fwd < 1 || fwd > 3) continue;
      const xi = [
        keepers[0],
        ...squad.filter((p) => p.positionShort === "DEF").sort((a, b) => score(b) - score(a)).slice(0, def),
        ...squad.filter((p) => p.positionShort === "MID").sort((a, b) => score(b) - score(a)).slice(0, mid),
        ...squad.filter((p) => p.positionShort === "FWD").sort((a, b) => score(b) - score(a)).slice(0, fwd),
      ].filter(Boolean);
      if (xi.length !== 11) continue;
      const ordered = [...xi].sort((a, b) => score(b) - score(a));
      const captain = ordered[0] ?? null;
      const vice = ordered[1] ?? null;
      const xiSum = xi.reduce((sum, p) => sum + score(p), 0);
      const captainBonus = captain ? score(captain) : 0;
      const grossEp = xiSum + captainBonus;
      if (grossEp > best.grossEp) {
        const xiIds = new Set(xi.map((p) => p.id));
        const bench = squad
          .filter((p) => !xiIds.has(p.id))
          .sort((a, b) => score(b) - score(a));
        best = { eventId, xi, captain, vice, bench, grossEp };
      }
    }
  }
  return best;
}

export function discountedSquadEp(
  squad: FplPlayer[],
  events: { id: number }[],
  data: FplData,
  firstEvent: number,
  discounts: readonly number[],
  project: (player: FplPlayer, eventId: number) => number,
): { weeklyGross: number[]; weeklyDiscounted: number[]; discountedTotal: number; undiscountedTotal: number } {
  const weeklyGross = events.map((event) =>
    optimalSquadWeek(squad, event.id, data, firstEvent, project).grossEp,
  );
  const weeklyDiscounted = weeklyGross.map((pts, index) => pts * (discounts[index] ?? discounts[discounts.length - 1] ?? 1));
  return {
    weeklyGross,
    weeklyDiscounted,
    discountedTotal: weeklyDiscounted.reduce((a, b) => a + b, 0),
    undiscountedTotal: weeklyGross.reduce((a, b) => a + b, 0),
  };
}

/**
 * Lightweight HOLD FT-banking path (frozen squad EP + FT path).
 * Full type-B HOLD with future free transfers lives in plan.bestFuturePlan —
 * recommendTransfers uses that. This helper remains for unit tests of FT banking.
 */
export function buildHoldBaseline(
  state: TeamState,
  data: FplData,
  rules: TransferEngineRules = DEFAULT_TRANSFER_RULES_2026_27,
  project?: (player: FplPlayer, eventId: number) => number,
): HoldBaseline | null {
  const events = futureEvents(data, rules.horizonGw);
  if (!events.length) return null;
  const first = events[0].id;
  const proj =
    project ??
    ((player: FplPlayer, eventId: number) => playerProjection(player, eventId, data.fixtures, first));
  const ep = discountedSquadEp(state.squad, events, data, first, rules.horizonDiscounts, proj);
  const freeTransfersPath: number[] = [];
  let ft = clampFreeTransfers(state.freeTransfers, rules);
  const pathSummary: string[] = [];
  for (let i = 0; i < events.length; i++) {
    const before = ft;
    ft = freeTransfersAfterDeadline(ft, 0, rules);
    freeTransfersPath.push(ft);
    pathSummary.push(`GW+${i}: HOLD (${before}→${ft} FT)`);
  }
  return {
    kind: "HOLD",
    planner: "type-B",
    weeklyGross: ep.weeklyGross,
    weeklyDiscounted: ep.weeklyDiscounted,
    discountedTotal: ep.discountedTotal,
    undiscountedTotal: ep.undiscountedTotal,
    freeTransfersPath,
    pathSummary,
  };
}

export function applyLegsToState(
  state: TeamState,
  legs: { out: FplPlayer; incoming: FplPlayer; sellingPrice: number; buyingPrice: number }[],
  hitCost: number,
  rules: TransferEngineRules,
): TeamState {
  void hitCost;
  const replacements = new Map(legs.map((leg) => [leg.out.id, leg.incoming]));
  const squad = state.squad.map((p) => replacements.get(p.id) ?? p);
  const selling = legs.reduce((sum, leg) => sum + leg.sellingPrice, 0);
  const buying = legs.reduce((sum, leg) => sum + leg.buyingPrice, 0);
  const bank = money(state.bank + selling - buying);
  const sellingPrices = new Map(state.sellingPrices);
  for (const leg of legs) {
    sellingPrices.delete(leg.out.id);
    sellingPrices.set(leg.incoming.id, leg.buyingPrice);
  }
  return {
    squad,
    bank,
    freeTransfers: freeTransfersAfterDeadline(state.freeTransfers, legs.length, rules),
    sellingPrices,
  };
}
