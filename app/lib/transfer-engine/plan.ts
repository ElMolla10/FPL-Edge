/**
 * Type-B future planner: HOLD/transfer-now allows later free transfers.
 * TransferNetEV = bestFuturePlan(transfer-now) − bestFuturePlan(hold-now).
 * Future weeks never take hits (wait for FT) so week-1 hit timing stays honest.
 */
import type { FplData, FplPlayer } from "../fpl";
import { exactHitCost, freeTransfersAfterDeadline, hitLabel, type TransferEngineRules } from "./rules";
import { isLegalSingleTransfer } from "./legality";
import { applyLegsToState, discountedSquadEp, optimalSquadWeek } from "./squad-ep";
import type { TeamState, TransferLeg } from "./types";

export type FuturePlanStep = {
  eventId: number;
  action: "HOLD" | "TRANSFER";
  outName?: string;
  inName?: string;
  outId?: number;
  inId?: number;
  hitCost: number;
  freeTransfersBefore: number;
  freeTransfersAfter: number;
  grossEp: number;
  discountedEp: number;
};

export type FuturePlan = {
  steps: FuturePlanStep[];
  /** Sum of discounted weekly EP minus hits paid across the horizon. */
  discountedTotal: number;
  undiscountedTotal: number;
  hitCostTotal: number;
  freeTransfersPath: number[];
};

export type CandidatePool = Map<number, FplPlayer[]>;

function remainingDiscountedEp(
  squad: FplPlayer[],
  events: { id: number }[],
  fromIndex: number,
  data: FplData,
  first: number,
  discounts: readonly number[],
  project: (p: FplPlayer, e: number) => number,
): number {
  const slice = events.slice(fromIndex);
  if (!slice.length) return 0;
  const localDiscounts = discounts.slice(fromIndex);
  return discountedSquadEp(squad, slice, data, first, localDiscounts, project).discountedTotal;
}

/**
 * Best future plan after a fixed week-0 action (HOLD or one forced transfer).
 * Later GWs: greedy free single transfers only when remaining-horizon gain clears margin.
 */
export function bestFuturePlan(
  state: TeamState,
  data: FplData,
  events: { id: number }[],
  first: number,
  pools: CandidatePool,
  project: (p: FplPlayer, e: number) => number,
  rules: TransferEngineRules,
  week0Legs: TransferLeg[] = [],
): FuturePlan {
  if (!events.length) {
    return { steps: [], discountedTotal: 0, undiscountedTotal: 0, hitCostTotal: 0, freeTransfersPath: [] };
  }

  let cur = state;
  const steps: FuturePlanStep[] = [];
  let discountedTotal = 0;
  let undiscountedTotal = 0;
  let hitCostTotal = 0;
  const freeTransfersPath: number[] = [];
  const margin = Math.max(0, rules.futureTransferMargin);

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const ftBefore = cur.freeTransfers;
    let hitCost = 0;
    let action: FuturePlanStep["action"] = "HOLD";
    let outName: string | undefined;
    let inName: string | undefined;
    let outId: number | undefined;
    let inId: number | undefined;

    if (i === 0 && week0Legs.length) {
      hitCost = exactHitCost(week0Legs.length, ftBefore, rules);
      cur = applyLegsToState(cur, week0Legs, hitCost, rules);
      // applyLegsToState already advances FT; undo that then re-apply after recording before/after
      // Actually applyLegsToState uses freeTransfersAfterDeadline — correct for post-deadline FT.
      // We need ftAfter from the new state.
      action = "TRANSFER";
      outName = week0Legs[0].out.name;
      inName = week0Legs[0].incoming.name;
      outId = week0Legs[0].out.id;
      inId = week0Legs[0].incoming.id;
      hitCostTotal += hitCost;
    } else if (i > 0 && cur.freeTransfers >= 1) {
      // Greedy best free transfer for remaining horizon (including this week).
      const rollRemaining = remainingDiscountedEp(
        cur.squad, events, i, data, first, rules.horizonDiscounts, project,
      );
      let bestGain = 0;
      let bestLeg: TransferLeg | null = null;
      for (const out of cur.squad) {
        const pool = pools.get(out.positionId) ?? [];
        for (const incoming of pool) {
          if (incoming.id === out.id) continue;
          const legal = isLegalSingleTransfer(
            data, cur.squad, out, incoming, cur.bank, cur.sellingPrices, rules,
          );
          if (!legal.legal) continue;
          // Free only — never take future hits in the type-B continuation.
          if (exactHitCost(1, cur.freeTransfers, rules) > 0) continue;
          const leg: TransferLeg = {
            out,
            incoming,
            sellingPrice: legal.sellingPrice,
            buyingPrice: incoming.price,
          };
          const next = applyLegsToState(cur, [leg], 0, rules);
          // Revert FT advance for EP compare: we want EP of next.squad from this week onward
          // with discounts aligned to absolute week index.
          const moveRemaining = remainingDiscountedEp(
            next.squad, events, i, data, first, rules.horizonDiscounts, project,
          );
          const gain = moveRemaining - rollRemaining;
          if (gain > bestGain + margin) {
            bestGain = gain;
            bestLeg = leg;
          }
        }
      }
      if (bestLeg) {
        cur = applyLegsToState(cur, [bestLeg], 0, rules);
        action = "TRANSFER";
        outName = bestLeg.out.name;
        inName = bestLeg.incoming.name;
        outId = bestLeg.out.id;
        inId = bestLeg.incoming.id;
      } else {
        cur = {
          ...cur,
          freeTransfers: freeTransfersAfterDeadline(cur.freeTransfers, 0, rules),
        };
      }
    } else {
      // HOLD / roll — bank FT
      if (i === 0 && week0Legs.length === 0) {
        cur = {
          ...cur,
          freeTransfers: freeTransfersAfterDeadline(cur.freeTransfers, 0, rules),
        };
      } else if (i > 0) {
        cur = {
          ...cur,
          freeTransfers: freeTransfersAfterDeadline(cur.freeTransfers, 0, rules),
        };
      }
    }

    // When week0 had legs, applyLegsToState already set freeTransfersAfterDeadline.
    // When week0 hold, we set it above. For i>0 transfer, applyLegsToState set it.
    // For i>0 hold, we set it above.
    const ftAfter = cur.freeTransfers;
    freeTransfersPath.push(ftAfter);

    const grossEp = optimalSquadWeek(cur.squad, event.id, data, first, project).grossEp;
    const discount = rules.horizonDiscounts[i] ?? rules.horizonDiscounts[rules.horizonDiscounts.length - 1] ?? 1;
    const discountedEp = grossEp * discount;
    // Hit is charged against week-0 points (exact FPL).
    const netDiscounted = i === 0 ? discountedEp - hitCost : discountedEp;
    discountedTotal += netDiscounted;
    undiscountedTotal += i === 0 ? grossEp - hitCost : grossEp;

    steps.push({
      eventId: event.id,
      action,
      outName,
      inName,
      outId,
      inId,
      hitCost,
      freeTransfersBefore: ftBefore,
      freeTransfersAfter: ftAfter,
      grossEp,
      discountedEp,
    });
  }

  return { steps, discountedTotal, undiscountedTotal, hitCostTotal, freeTransfersPath };
}

/** Wait-one-GW plan: HOLD now, force the same transfer next GW if a free FT will exist. */
export function waitOneGwThenTransferPlan(
  state: TeamState,
  data: FplData,
  events: { id: number }[],
  first: number,
  pools: CandidatePool,
  project: (p: FplPlayer, e: number) => number,
  rules: TransferEngineRules,
  leg: TransferLeg,
): FuturePlan | null {
  if (events.length < 2) return null;
  // HOLD week 0
  const afterHold: TeamState = {
    ...state,
    freeTransfers: freeTransfersAfterDeadline(state.freeTransfers, 0, rules),
  };
  const week0Ep = optimalSquadWeek(state.squad, events[0].id, data, first, project).grossEp;
  const week0Disc = week0Ep * (rules.horizonDiscounts[0] ?? 1);

  // Force transfer at week 1 if free; else fall back to bestFuturePlan hold continuation
  const ftAtW1 = afterHold.freeTransfers;
  const hitAtW1 = exactHitCost(1, ftAtW1, rules);
  if (hitAtW1 > 0) {
    // Still would need a hit next week — waiting does not help; return null so caller skips timing.
    return null;
  }
  const legal = isLegalSingleTransfer(
    data, afterHold.squad, leg.out, leg.incoming, afterHold.bank, afterHold.sellingPrices, rules,
  );
  if (!legal.legal) return null;

  const forcedLeg: TransferLeg = {
    out: leg.out,
    incoming: leg.incoming,
    sellingPrice: legal.sellingPrice,
    buyingPrice: leg.incoming.price,
  };
  // Build remaining plan from week 1 with forced transfer as "week0" of a sub-plan
  const restEvents = events.slice(1);
  const restDiscounts = rules.horizonDiscounts.slice(1);
  const restRules = { ...rules, horizonDiscounts: restDiscounts };
  const rest = bestFuturePlan(
    afterHold, data, restEvents, first, pools, project, restRules, [forcedLeg],
  );

  const steps: FuturePlanStep[] = [
    {
      eventId: events[0].id,
      action: "HOLD",
      hitCost: 0,
      freeTransfersBefore: state.freeTransfers,
      freeTransfersAfter: afterHold.freeTransfers,
      grossEp: week0Ep,
      discountedEp: week0Disc,
    },
    ...rest.steps,
  ];
  return {
    steps,
    discountedTotal: week0Disc + rest.discountedTotal,
    undiscountedTotal: week0Ep + rest.undiscountedTotal,
    hitCostTotal: rest.hitCostTotal,
    freeTransfersPath: [afterHold.freeTransfers, ...rest.freeTransfersPath],
  };
}

export function summarizePlanPath(plan: FuturePlan, maxSteps = 5): string[] {
  return plan.steps.slice(0, maxSteps).map((step, index) => {
    const gw = `GW+${index}`;
    if (step.action === "HOLD") {
      return `${gw}: HOLD (${step.freeTransfersBefore}→${step.freeTransfersAfter} FT)`;
    }
    const hit = step.hitCost > 0 ? ` ${hitLabel(step.hitCost)}` : " free";
    return `${gw}: ${step.outName}→${step.inName}${hit} (${step.freeTransfersBefore}→${step.freeTransfersAfter} FT)`;
  });
}
