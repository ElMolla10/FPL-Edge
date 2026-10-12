import { futureEvents, playerProjection, projectionMetrics, ROLE_SECURITY_FLOOR, type FplData, type FplPlayer } from "../fpl";
import { generateRouteOpeningActions } from "../transfer-routes";
import { createTeamState, riskMultiplier, scoreCandidatePool } from "../transfer-engine/recommend";
import { bestFuturePlan, type FuturePlan, type PlanBudget } from "../transfer-engine/plan";
import { DEFAULT_TRANSFER_RULES_2026_27, type TransferEngineRules } from "../transfer-engine/rules";
import { classifyTransfer } from "../transfer-engine/classify";
import type { TransferLeg } from "../transfer-engine/types";

type Action = { legs: TransferLeg[]; plan: FuturePlan; rawNet: number; riskAdjustedNet: number;
  riskMultiplier: number; classification: string };
export type BundleComparison = { complete: boolean; hold: FuturePlan | null; actions: Action[]; bestPair: Action | null;
  work: { used: number; limit: number; plansStarted: number } };

export const BUNDLE_COMPUTATION_LIMITS = Object.freeze({ units: 40_000, players: 1_000, planNodes: 6_000, horizon: 5 });
class ComputationBudgetExceeded extends Error {}
// Canonical keys contain only ASCII digits, ':' and '|': code-unit order is byte order.
const compareKeys = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Free opening pairs only. Every action gets the SAME full type-B continuation
 * budget, pools, horizon and discounts. Any incomplete plan discards the comparison.
 * Singles are re-scored here; legacy budget-truncated scores are never mixed in.
 */
export function compareFreeTransferBundles(
  data: FplData, squad: FplPlayer[], bank: number, ft: number, selling: Map<number, number>,
  fallback: TransferLeg[], overrides: Partial<TransferEngineRules> & { maxComputationUnits?: number } = {},
): BundleComparison {
  const requestedLimit = overrides.maxComputationUnits ?? BUNDLE_COMPUTATION_LIMITS.units;
  const work = { used: 0, limit: Math.max(0, Math.min(BUNDLE_COMPUTATION_LIMITS.units, Math.floor(requestedLimit))), plansStarted: 0 };
  const failed: BundleComparison = { complete: false, hold: null, actions: [], bestPair: null, work };
  if (ft < 2 || !Number.isFinite(ft) || !Number.isFinite(requestedLimit) ||
    data.players.length > BUNDLE_COMPUTATION_LIMITS.players || squad.length !== 15 || data.rules.positions.length > 4) return failed;
  const charge = (units = 1) => {
    if (work.used + units > work.limit) throw new ComputationBudgetExceeded();
    work.used += units;
  };
  try {
    // Stable ties in the shared future pool must not depend on bootstrap row order.
    data = { ...data, players: [...data.players].sort((a,b)=>a.id-b.id) };
    const rules = { ...DEFAULT_TRANSFER_RULES_2026_27, planTimeBudgetMs: 120_000, ...overrides };
    const events = futureEvents(data, rules.horizonGw);
    if (!events.length || events.length > BUNDLE_COMPUTATION_LIMITS.horizon) return failed;
    const perPlanLimit = Math.min(BUNDLE_COMPUTATION_LIMITS.planNodes, Math.floor(rules.maxPlanNodes));
    if (!Number.isFinite(perPlanLimit) || perPlanLimit < 1) return failed;
    const first = events[0].id;
    const state = createTeamState(squad, bank, ft, selling, rules);
    const projections = new Map<string, number>();
    const metricsCache = new Map<string, ReturnType<typeof projectionMetrics>>();
    const project = (p: FplPlayer, e: number) => {
      const key = `${p.id}:${e}`;
      if (!projections.has(key)) { charge(); projections.set(key, playerProjection(p, e, data.fixtures, first)); }
      return projections.get(key)!;
    };
    const metrics = (p: FplPlayer, e: number) => {
      const key = `${p.id}:${e}`;
      if (!metricsCache.has(key)) { charge(); metricsCache.set(key, projectionMetrics(p, e, data.fixtures, first)); }
      return metricsCache.get(key)!;
    };
    const eligible = (p: FplPlayer) => {
      const m = metrics(p, first);
      return p.status === "a" && (p.chance === null || p.chance >= 75) &&
        m.startProbability >= ROLE_SECURITY_FLOOR.startProbability &&
        m.expectedMinutes >= ROLE_SECURITY_FLOOR.expectedMinutes && m.confidence >= ROLE_SECURITY_FLOOR.confidence;
    };
    const remaining = (p: FplPlayer) => events.reduce((s,e,i)=>s+project(p,e.id)*(rules.horizonDiscounts[i]??1),0);
    const pools = scoreCandidatePool(data, events, first, project, metrics, rules);
    const menu = generateRouteOpeningActions(data, squad, bank, selling, remaining, eligible, charge);
    const key = (legs: TransferLeg[]) => legs.map(l=>`${l.out.id}:${l.incoming.id}`).sort(compareKeys).join("|");
    menu.sort((a,b)=>b.reduce((s,l)=>s+l.horizonGain,0)-a.reduce((s,l)=>s+l.horizonGain,0)||compareKeys(key(a),key(b)));
    // Distinct quotas prevent single moves from crowding all bundles out.
    const pairs = menu.filter(a=>a.length===2);
    const fundingPairs = pairs.filter(a=>a.some(l=>l.bankChange>0)&&a.some(l=>l.bankChange<0));
    const selected: TransferLeg[][] = [...menu.filter(a=>a.length===1).slice(0,12), ...pairs.slice(0,8), ...fundingPairs.slice(0,4)];
    if (fallback.length === 1) selected.push(fallback);
    const unique = [...new Map(selected.map(a=>[key(a),a])).values()];
    const plan = (legs: TransferLeg[]) => {
      // Reserve an equal complete plan allowance, plus at most two new cache entries
      // per owned player/event. No partial plan receives a smaller search allowance.
      if (work.limit - work.used < perPlanLimit + squad.length * events.length * 2) return null;
      const budget: PlanBudget = { nodes: 0, maxNodes: perPlanLimit, deadlineMs: Number.POSITIVE_INFINITY,
        exhausted: false, deepBeamInvocations: 0 };
      work.plansStarted++;
      const result = bestFuturePlan(state, data, events, first, pools, project, rules, legs, budget);
      // The shared planner can finish bounded weekly totals after exhaustion; those
      // do not authorize a decision. Charge the attempted capped search and discard.
      charge(Math.min(budget.nodes, perPlanLimit));
      return budget.exhausted ? null : result;
    };
    const hold = plan([]);
    if (!hold) return failed;
    const actions: Action[] = [];
    for (const legs of unique) {
      const continuation = plan(legs);
      if (!continuation) return failed;
      const rawNet = continuation.discountedTotal - hold.discountedTotal;
      // Weakest incoming evidence: same confidence-only formula as single moves,
      // applied ONCE to bundle NET; minutes/start are already in projections.
      const incoming = legs.map(l=>metrics(l.incoming,first));
      const confidence = Math.min(...incoming.map(m=>m.confidence));
      const multiplier = riskMultiplier(0, confidence);
      const riskAdjustedNet = rawNet > 0 ? rawNet * multiplier : rawNet;
      const inMetrics = { ...incoming[0], confidence,
        startProbability: Math.min(...incoming.map(m=>m.startProbability)),
        expectedMinutes: Math.min(...incoming.map(m=>m.expectedMinutes)) };
      const threeGwNetVsHold = continuation.steps.slice(0,3).reduce((s,w)=>s+w.discountedEp,0)-hold.steps.slice(0,3).reduce((s,w)=>s+w.discountedEp,0);
      const classification = classifyTransfer({ net: { transferCount: legs.length, hitCost: 0,
        inMetrics, riskAdjustedFiveGwNetVsHold: riskAdjustedNet, threeGwNetVsHold } }, rules).classification;
      actions.push({ legs, plan: continuation, rawNet, riskAdjustedNet, riskMultiplier: multiplier, classification });
    }
    const actionable = (a: Action) => a.classification === "MAKE" || a.classification === "LEAN";
    const singleFloor = Math.max(0, ...actions.filter(a=>a.legs.length===1).map(a=>a.riskAdjustedNet));
    const bestPair = actions.filter(a=>a.legs.length===2 && actionable(a) && a.riskAdjustedNet > singleFloor + 1e-9)
      .sort((a,b)=>b.riskAdjustedNet-a.riskAdjustedNet||compareKeys(key(a.legs),key(b.legs)))[0] ?? null;
    return { complete: true, hold, actions, bestPair, work };
  } catch (error) {
    if (error instanceof ComputationBudgetExceeded) return failed;
    throw error;
  }
}
