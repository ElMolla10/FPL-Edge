/**
 * Type-B future planner: HOLD/transfer-now allows later free transfers.
 * TransferNetEV = bestFuturePlan(transfer-now) − bestFuturePlan(hold-now).
 * Future weeks never take hits (wait for FT) so week-1 hit timing stays honest.
 *
 * Non-blocking budgets: node + wall-clock caps, memoized remaining EP, futureBeamWidth
 * pruning. futureBeamWidth === 0 skips deep future search (Overview / mode:'shallow').
 * deepBeamInvocations on PlanBudget must stay 0 on the Overview sync path.
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

/** Structured future-path leg for UI drilldown ("WHY THIS FUTURE MOVE?"). */
export type PlanPathLeg = {
  eventId: number;
  offset: number;
  action: "HOLD" | "TRANSFER";
  outName?: string;
  inName?: string;
  outId?: number;
  inId?: number;
  hitCost: number;
  freeTransfersBefore: number;
  freeTransfersAfter: number;
  weeklyGross: number;
  discountedEp: number;
  /** Slice of plan EP net of hit for this step (hit only in week 0 when paid). */
  netEp: number;
  summary: string;
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

/** Shared search budget for one recommendTransfers / bestFuturePlan tree. */
export type PlanBudget = {
  nodes: number;
  maxNodes: number;
  deadlineMs: number;
  exhausted: boolean;
  /** Counts entries into the deep future free-transfer beam (must stay 0 on Overview). */
  deepBeamInvocations: number;
};

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function createPlanBudget(rules: TransferEngineRules, startedAt = nowMs()): PlanBudget {
  return {
    nodes: 0,
    maxNodes: Math.max(64, rules.maxPlanNodes),
    deadlineMs: startedAt + Math.max(8, rules.planTimeBudgetMs),
    exhausted: false,
    deepBeamInvocations: 0,
  };
}

export function budgetOk(budget: PlanBudget | undefined): boolean {
  if (!budget) return true;
  if (budget.exhausted) return false;
  if (budget.nodes >= budget.maxNodes || nowMs() >= budget.deadlineMs) {
    budget.exhausted = true;
    return false;
  }
  return true;
}

export function chargeBudget(budget: PlanBudget | undefined, cost = 1): boolean {
  if (!budget) return true;
  budget.nodes += cost;
  return budgetOk(budget);
}

function squadKey(squad: FplPlayer[]): string {
  let key = "";
  for (let i = 0; i < squad.length; i++) {
    if (i) key += ",";
    key += squad[i].id;
  }
  return key;
}

function remainingDiscountedEp(
  squad: FplPlayer[],
  events: { id: number }[],
  fromIndex: number,
  data: FplData,
  first: number,
  discounts: readonly number[],
  project: (p: FplPlayer, e: number) => number,
  cache?: Map<string, number>,
): number {
  const slice = events.slice(fromIndex);
  if (!slice.length) return 0;
  const key = `${squadKey(squad)}|${fromIndex}`;
  if (cache?.has(key)) return cache.get(key)!;
  const localDiscounts = discounts.slice(fromIndex);
  const total = discountedSquadEp(squad, slice, data, first, localDiscounts, project).discountedTotal;
  cache?.set(key, total);
  return total;
}

function cheapIndividualRemaining(
  out: FplPlayer,
  incoming: FplPlayer,
  events: { id: number }[],
  fromIndex: number,
  discounts: readonly number[],
  project: (p: FplPlayer, e: number) => number,
): number {
  let gain = 0;
  for (let i = fromIndex; i < events.length; i++) {
    const d = discounts[i] ?? discounts[discounts.length - 1] ?? 1;
    gain += (project(incoming, events[i].id) - project(out, events[i].id)) * d;
  }
  return gain;
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
  budget?: PlanBudget,
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
  const epCache = new Map<string, number>();
  const futureBeam = Math.max(0, rules.futureBeamWidth ?? rules.beamWidth ?? 0);

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
    } else if (i > 0 && cur.freeTransfers >= 1 && futureBeam > 0 && budgetOk(budget)) {
      if (budget) budget.deepBeamInvocations += 1;
      // Greedy best free transfer for remaining horizon (including this week).
      const rollRemaining = remainingDiscountedEp(
        cur.squad, events, i, data, first, rules.horizonDiscounts, project, epCache,
      );
      type Cand = { leg: TransferLeg; cheap: number };
      const cheapList: Cand[] = [];
      for (const out of cur.squad) {
        if (!budgetOk(budget)) break;
        const pool = pools.get(out.positionId) ?? [];
        for (const incoming of pool) {
          if (incoming.id === out.id) continue;
          if (!chargeBudget(budget, 1)) break;
          const legal = isLegalSingleTransfer(
            data, cur.squad, out, incoming, cur.bank, cur.sellingPrices, rules,
          );
          if (!legal.legal) continue;
          if (exactHitCost(1, cur.freeTransfers, rules) > 0) continue;
          const cheap = cheapIndividualRemaining(
            out, incoming, events, i, rules.horizonDiscounts, project,
          );
          if (cheap <= margin) continue;
          cheapList.push({
            leg: {
              out,
              incoming,
              sellingPrice: legal.sellingPrice,
              buyingPrice: incoming.price,
            },
            cheap,
          });
        }
      }
      cheapList.sort((a, b) => b.cheap - a.cheap);
      const beamed = cheapList.slice(0, futureBeam);

      let bestGain = 0;
      let bestLeg: TransferLeg | null = null;
      for (const cand of beamed) {
        if (!chargeBudget(budget, 2)) break;
        const next = applyLegsToState(cur, [cand.leg], 0, rules);
        const moveRemaining = remainingDiscountedEp(
          next.squad, events, i, data, first, rules.horizonDiscounts, project, epCache,
        );
        const gain = moveRemaining - rollRemaining;
        if (gain > bestGain + margin) {
          bestGain = gain;
          bestLeg = cand.leg;
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

    chargeBudget(budget, 1);
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
  budget?: PlanBudget,
): FuturePlan | null {
  if (events.length < 2) return null;
  if (!budgetOk(budget)) return null;
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
    afterHold, data, restEvents, first, pools, project, restRules, [forcedLeg], budget,
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
  return explainPlanPath(plan, maxSteps).map((leg) => leg.summary);
}

/** Structured metrics at each simulated GW for transfer-now / hold-now drilldown. */
export function explainPlanPath(plan: FuturePlan, maxSteps = 5): PlanPathLeg[] {
  return plan.steps.slice(0, maxSteps).map((step, index) => {
    const gw = `GW+${index}`;
    const netEp = step.discountedEp - (index === 0 ? step.hitCost : 0);
    let summary: string;
    if (step.action === "HOLD") {
      summary = `${gw}: HOLD (${step.freeTransfersBefore}→${step.freeTransfersAfter} FT) · ${step.grossEp.toFixed(1)} xPts`;
    } else {
      const hit = step.hitCost > 0 ? ` ${hitLabel(step.hitCost)}` : " free";
      summary = `${gw}: ${step.outName}→${step.inName}${hit} (${step.freeTransfersBefore}→${step.freeTransfersAfter} FT) · ${step.grossEp.toFixed(1)} xPts`;
    }
    return {
      eventId: step.eventId,
      offset: index,
      action: step.action,
      outName: step.outName,
      inName: step.inName,
      outId: step.outId,
      inId: step.inId,
      hitCost: step.hitCost,
      freeTransfersBefore: step.freeTransfersBefore,
      freeTransfersAfter: step.freeTransfersAfter,
      weeklyGross: step.grossEp,
      discountedEp: step.discountedEp,
      netEp,
      summary,
    };
  });
}
