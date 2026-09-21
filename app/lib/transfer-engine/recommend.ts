import {
  FplData,
  FplPlayer,
  ROLE_SECURITY_FLOOR,
  futureEvents,
  isCompleteSquad,
  playerProjection,
  projectionMetrics,
} from "../fpl";
import {
  DEFAULT_TRANSFER_RULES_2026_27,
  OVERVIEW_TRANSFER_RULES,
  TransferEngineRules,
  clampFreeTransfers,
  exactHitCost,
  hitLabel,
  mergeTransferRules,
} from "./rules";
import { isShallowPlanning } from "./schedule";
import { isLegalSingleTransfer, sellingPriceFor } from "./legality";
import { buildRecommendationCard, classifyTransfer } from "./classify";
import {
  applyLegsToState,
  optimalSquadWeek,
} from "./squad-ep";
import {
  bestFuturePlan,
  budgetOk,
  createPlanBudget,
  summarizePlanPath,
  waitOneGwThenTransferPlan,
  type PlanBudget,
} from "./plan";
import type {
  BestDecision,
  HoldBaseline,
  RiskDriver,
  TeamState,
  TransferEngineOptions,
  TransferEngineResult,
  TransferLeg,
  TransferNetEV,
  TransferRecommendation,
  TransferRecommendationCard,
} from "./types";

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const money = (value: number) => Math.round((value + Number.EPSILON) * 10) / 10;

export function createTeamState(
  squad: FplPlayer[],
  bank: number,
  freeTransfers: number,
  sellingPrices: Map<number, number> = new Map(),
  rules: TransferEngineRules = DEFAULT_TRANSFER_RULES_2026_27,
): TeamState {
  const prices = new Map(sellingPrices);
  for (const player of squad) {
    if (!prices.has(player.id)) prices.set(player.id, sellingPriceFor(player, prices));
  }
  return {
    squad: [...squad],
    bank: money(Number.isFinite(bank) ? bank : 0),
    freeTransfers: clampFreeTransfers(freeTransfers, rules),
    sellingPrices: prices,
  };
}

function riskMultiplier(startProbability: number, confidence: number): number {
  // Bounded 0.55–1.0 — same philosophy as the prior engine: never invert via over-discount.
  return clamp(0.55 + startProbability * 0.25 + confidence * 0.2, 0.55, 1);
}

function buildRiskDrivers(
  out: FplPlayer,
  incoming: FplPlayer,
  om: ReturnType<typeof projectionMetrics>,
  im: ReturnType<typeof projectionMetrics>,
  hitCost: number,
  shortTerm: number,
): RiskDriver[] {
  const drivers: RiskDriver[] = [];
  if (im.startProbability < 0.8) {
    drivers.push({
      code: "start-prob",
      label: "Start probability",
      detail: `Incoming start chance ${Math.round(im.startProbability * 100)}% (outgoing ${Math.round(om.startProbability * 100)}%).`,
    });
  }
  if (im.expectedMinutes < 70) {
    drivers.push({
      code: "minutes",
      label: "Expected minutes",
      detail: `Incoming expected minutes ${Math.round(im.expectedMinutes)} — rotation risk.`,
    });
  }
  if (im.confidence < 0.55) {
    drivers.push({
      code: "evidence",
      label: "Projection evidence",
      detail: `Evidence strength ${Math.round(im.confidence * 100)}% (confidence ≠ risk).`,
    });
  }
  if (hitCost > 0 && shortTerm < 0) {
    drivers.push({
      code: "hit-short-term",
      label: "Hit vs short-term",
      detail: `Paying −${hitCost} with negative modelled 3-GW NET.`,
    });
  }
  if (im.startProbability < om.startProbability - 0.05) {
    drivers.push({
      code: "role-downgrade",
      label: "Role security drop",
      detail: `${incoming.name} has a weaker start profile than ${out.name}.`,
    });
  }
  if (!drivers.length) {
    drivers.push({
      code: "low-risk",
      label: "Low structural risk",
      detail: "Start chance, minutes and evidence clear the comfortable band.",
    });
  }
  return drivers;
}

function scoreCandidatePool(
  data: FplData,
  events: { id: number }[],
  first: number,
  project: (p: FplPlayer, e: number) => number,
  metrics: (p: FplPlayer, e: number) => ReturnType<typeof projectionMetrics>,
  rules: TransferEngineRules,
): Map<number, FplPlayer[]> {
  const remaining = (player: FplPlayer) =>
    events.reduce((sum, event, index) => {
      const discount = rules.horizonDiscounts[index] ?? 1;
      return sum + project(player, event.id) * discount;
    }, 0);

  const eligible = (player: FplPlayer) => {
    if (player.status === "u") return false;
    const m = metrics(player, first);
    return (
      m.startProbability >= ROLE_SECURITY_FLOOR.startProbability &&
      m.expectedMinutes >= ROLE_SECURITY_FLOOR.expectedMinutes &&
      m.confidence >= ROLE_SECURITY_FLOOR.confidence
    );
  };

  const byPos = new Map<number, FplPlayer[]>();
  for (const rule of data.rules.positions) {
    const players = data.players
      .filter((p) => p.positionId === rule.id && eligible(p))
      .sort((a, b) => {
        const am = metrics(a, first);
        const bm = metrics(b, first);
        const aScore = remaining(a) * (0.72 + 0.16 * am.startProbability + 0.12 * am.confidence);
        const bScore = remaining(b) * (0.72 + 0.16 * bm.startProbability + 0.12 * bm.confidence);
        return bScore - aScore || a.price - b.price;
      })
      .slice(0, rules.candidatePoolPerPosition);
    byPos.set(rule.id, players);
  }
  return byPos;
}

function evaluateSingleMove(
  data: FplData,
  state: TeamState,
  holdPlan: ReturnType<typeof bestFuturePlan>,
  hold: HoldBaseline,
  out: FplPlayer,
  incoming: FplPlayer,
  events: { id: number }[],
  first: number,
  project: (p: FplPlayer, e: number) => number,
  pools: Map<number, FplPlayer[]>,
  rules: TransferEngineRules,
  budget: PlanBudget,
  computeTiming: boolean,
): TransferNetEV | null {
  const legal = isLegalSingleTransfer(
    data,
    state.squad,
    out,
    incoming,
    state.bank,
    state.sellingPrices,
    rules,
  );
  if (!legal.legal) return null;

  const hitCost = exactHitCost(1, state.freeTransfers, rules);
  if (hitCost > rules.maxWeek1Hit) return null;

  const leg: TransferLeg = {
    out,
    incoming,
    sellingPrice: legal.sellingPrice,
    buyingPrice: incoming.price,
  };
  const nextState = applyLegsToState(state, [leg], hitCost, rules);

  // Type-B: NET = best future plan after transfer-now − best future plan after hold-now
  if (!budgetOk(budget)) return null;
  const transferPlan = bestFuturePlan(state, data, events, first, pools, project, rules, [leg], budget);
  const fiveGwNetVsHold = transferPlan.discountedTotal - holdPlan.discountedTotal;

  // 3-GW slice of the same plans (hits fully in week 1 already inside discounted totals)
  const transfer3 = transferPlan.steps.slice(0, 3).reduce((s, step, idx) => {
    const disc = step.discountedEp - (idx === 0 ? step.hitCost : 0);
    return s + disc;
  }, 0);
  const hold3 = holdPlan.steps.slice(0, 3).reduce((s, step) => s + step.discountedEp, 0);
  const threeGwNetVsHold = transfer3 - hold3;

  const om = projectionMetrics(out, first, data.fixtures, first);
  const im = projectionMetrics(incoming, first, data.fixtures, first);
  const outByEvent = events.map((e) => project(out, e.id));
  const inByEvent = events.map((e) => project(incoming, e.id));
  const sum = (arr: number[], n?: number) =>
    (n === undefined ? arr : arr.slice(0, n)).reduce((a, b) => a + b, 0);

  const mult = riskMultiplier(im.startProbability, im.confidence);
  const riskAdjustedFiveGwNetVsHold = fiveGwNetVsHold > 0 ? fiveGwNetVsHold * mult : fiveGwNetVsHold;

  const confidence = clamp(
    0.35 * im.startProbability + 0.35 * im.confidence + 0.3 * clamp(im.expectedMinutes / 90, 0, 1),
    0,
    1,
  );
  const risk: TransferNetEV["risk"] =
    im.startProbability > 0.8 && im.startProbability >= om.startProbability
      ? "Low"
      : im.startProbability > 0.62
        ? "Medium"
        : "High";

  const nextGwGross = optimalSquadWeek(nextState.squad, first, data, first, project).grossEp;
  const weeklyGrossDeltas = transferPlan.steps.map((step, i) => step.grossEp - (holdPlan.steps[i]?.grossEp ?? 0));
  const grossDelta1 = weeklyGrossDeltas[0] ?? 0;
  const grossDelta3 = weeklyGrossDeltas.slice(0, 3).reduce((a, b) => a + b, 0);
  const grossDelta5 = weeklyGrossDeltas.reduce((a, b) => a + b, 0);

  let timingEvVsWait: number | null = null;
  // Timing EV is an extra full plan — skip on Overview/shallow or when budget is tight.
  if (hitCost > 0 && computeTiming && budgetOk(budget)) {
    const waitPlan = waitOneGwThenTransferPlan(
      state, data, events, first, pools, project, rules, leg, budget,
    );
    if (waitPlan) {
      timingEvVsWait = transferPlan.discountedTotal - waitPlan.discountedTotal;
    }
  }

  const ftUsed = Math.min(1, state.freeTransfers);
  const riskDrivers = buildRiskDrivers(out, incoming, om, im, hitCost, threeGwNetVsHold);

  return {
    legs: [leg],
    transferCount: 1,
    hitCost,
    hitLabel: hitLabel(hitCost, rules),
    bankAfter: nextState.bank,
    freeTransfersAfter: nextState.freeTransfers,
    freeTransfersBefore: state.freeTransfers,
    transfersRequired: 1,
    freeTransfersUsed: ftUsed,
    nextGwGross,
    holdNextGwGross: hold.weeklyGross[0] ?? 0,
    grossDelta1,
    grossDelta3,
    grossDelta5,
    fiveGwNetVsHold,
    threeGwNetVsHold,
    riskAdjustedFiveGwNetVsHold,
    netEv5: fiveGwNetVsHold,
    netEv3: threeGwNetVsHold,
    riskAdjustedNet5: riskAdjustedFiveGwNetVsHold,
    riskAdjustment: mult,
    confidence,
    risk,
    riskDrivers,
    weeklyGrossDeltas,
    outMetrics: om,
    inMetrics: im,
    individualGain1: (inByEvent[0] ?? 0) - (outByEvent[0] ?? 0),
    individualGain3: sum(inByEvent, 3) - sum(outByEvent, 3),
    individualGain5: sum(inByEvent) - sum(outByEvent),
    outGw1: outByEvent[0] ?? 0,
    inGw1: inByEvent[0] ?? 0,
    outGw3: sum(outByEvent, 3),
    inGw3: sum(inByEvent, 3),
    outGw5: sum(outByEvent),
    inGw5: sum(inByEvent),
    transferNowPlanTotal: transferPlan.discountedTotal,
    holdNowPlanTotal: holdPlan.discountedTotal,
    timingEvVsWait,
    transferNowPath: summarizePlanPath(transferPlan),
    holdNowPath: summarizePlanPath(holdPlan),
    reasonCodes: [],
  };
}

/**
 * Cap clusters that share the same outgoing or incoming player so one family
 * cannot dominate the top N. Already-sorted by riskAdjustedFiveGwNetVsHold desc.
 */
export function diversifyRecommendations(
  rows: TransferRecommendation[],
  rules: TransferEngineRules,
): TransferRecommendation[] {
  const maxOut = Math.max(1, rules.maxSameOutgoingInResults);
  const maxIn = Math.max(1, rules.maxSameIncomingInResults);
  const outCount = new Map<number, number>();
  const inCount = new Map<number, number>();
  const kept: TransferRecommendation[] = [];
  for (const row of rows) {
    if (row.classification === "HOLD" || row.net.transferCount === 0 || !row.net.legs.length) {
      kept.push(row);
      continue;
    }
    const outId = row.net.legs[0].out.id;
    const inId = row.net.legs[0].incoming.id;
    const o = outCount.get(outId) ?? 0;
    const i = inCount.get(inId) ?? 0;
    if (o >= maxOut || i >= maxIn) continue;
    outCount.set(outId, o + 1);
    inCount.set(inId, i + 1);
    kept.push(row);
  }
  return kept;
}

/** Group moves that share the same out or in into family clusters (for UI). */
export function groupTransferFamilies(
  rows: TransferRecommendation[],
): { key: string; kind: "out" | "in"; playerId: number; playerName: string; members: TransferRecommendation[] }[] {
  const byOut = new Map<number, TransferRecommendation[]>();
  const byIn = new Map<number, TransferRecommendation[]>();
  for (const row of rows) {
    if (!row.net.legs.length) continue;
    const out = row.net.legs[0].out;
    const inn = row.net.legs[0].incoming;
    if (!byOut.has(out.id)) byOut.set(out.id, []);
    byOut.get(out.id)!.push(row);
    if (!byIn.has(inn.id)) byIn.set(inn.id, []);
    byIn.get(inn.id)!.push(row);
  }
  const families: { key: string; kind: "out" | "in"; playerId: number; playerName: string; members: TransferRecommendation[] }[] = [];
  for (const [id, members] of byOut) {
    if (members.length < 2) continue;
    families.push({
      key: `out-${id}`,
      kind: "out",
      playerId: id,
      playerName: members[0].net.legs[0].out.name,
      members,
    });
  }
  for (const [id, members] of byIn) {
    if (members.length < 2) continue;
    families.push({
      key: `in-${id}`,
      kind: "in",
      playerId: id,
      playerName: members[0].net.legs[0].incoming.name,
      members,
    });
  }
  return families;
}

function buildHoldRecommendation(
  state: TeamState,
  hold: HoldBaseline,
  holdPlan: ReturnType<typeof bestFuturePlan>,
  first: number,
  data: FplData,
): TransferRecommendation {
  const { classification, reason, reasonCodes } = classifyTransfer({ isHold: true });
  const net: TransferNetEV = {
    legs: [],
    transferCount: 0,
    hitCost: 0,
    hitLabel: "Free",
    bankAfter: state.bank,
    freeTransfersAfter: hold.freeTransfersPath[0] ?? state.freeTransfers,
    freeTransfersBefore: state.freeTransfers,
    transfersRequired: 0,
    freeTransfersUsed: 0,
    nextGwGross: hold.weeklyGross[0] ?? 0,
    holdNextGwGross: hold.weeklyGross[0] ?? 0,
    grossDelta1: 0,
    grossDelta3: 0,
    grossDelta5: 0,
    fiveGwNetVsHold: 0,
    threeGwNetVsHold: 0,
    riskAdjustedFiveGwNetVsHold: 0,
    netEv5: 0,
    netEv3: 0,
    riskAdjustedNet5: 0,
    riskAdjustment: 1,
    confidence: 1,
    risk: "Low",
    riskDrivers: [
      {
        code: "hold-option",
        label: "Future free transfers",
        detail: "Type-B HOLD banks FT and keeps later free upgrades available.",
      },
    ],
    weeklyGrossDeltas: hold.weeklyGross.map(() => 0),
    outMetrics: projectionMetrics(state.squad[0], first, data.fixtures, first),
    inMetrics: projectionMetrics(state.squad[0], first, data.fixtures, first),
    individualGain1: 0,
    individualGain3: 0,
    individualGain5: 0,
    outGw1: 0,
    inGw1: 0,
    outGw3: 0,
    inGw3: 0,
    outGw5: 0,
    inGw5: 0,
    transferNowPlanTotal: holdPlan.discountedTotal,
    holdNowPlanTotal: holdPlan.discountedTotal,
    timingEvVsWait: null,
    transferNowPath: hold.pathSummary,
    holdNowPath: hold.pathSummary,
    reasonCodes,
  };
  const card = buildRecommendationCard(classification, reason, net);
  return {
    classification,
    reason,
    net,
    card: {
      ...card,
      bankAfter: state.bank,
      nextGwGross: hold.weeklyGross[0] ?? 0,
      threeGwNetVsHold: 0,
      fiveGwNetVsHold: 0,
      riskAdjustedFiveGwNetVsHold: 0,
      net3: 0,
      net5: 0,
      riskAdjustedNet5: 0,
      confidence: 1,
      risk: "Low",
      outName: "HOLD",
      inName: "NO TRANSFER",
      reason,
      holdNowPath: hold.pathSummary,
      freeTransfersBefore: state.freeTransfers,
      freeTransfersAfter: hold.freeTransfersPath[0] ?? state.freeTransfers,
    },
  };
}

function buildBestDecision(
  primary: TransferRecommendation,
  recommendations: TransferRecommendation[],
): BestDecision {
  const isHold = primary.classification === "HOLD" || primary.net.transferCount === 0;
  const alternative = isHold
    ? recommendations.find(
        (r) =>
          r.classification !== "HOLD" &&
          r.classification !== "AVOID" &&
          r.net.transferCount > 0,
      ) ?? null
    : recommendations.find(
        (r) =>
          r !== primary &&
          (r.classification === "HOLD" || r.net.riskAdjustedFiveGwNetVsHold > 0),
      ) ?? null;

  const net = primary.net;
  if (isHold) {
    return {
      action: "HOLD",
      classification: "HOLD",
      headline: "HOLD — do not transfer now",
      reason: primary.reason,
      confidence: 1,
      risk: "Low",
      hitLabel: "Free",
      hitCost: 0,
      threeGwNetVsHold: 0,
      fiveGwNetVsHold: 0,
      riskAdjustedFiveGwNetVsHold: 0,
      alternative,
      recommendation: primary,
    };
  }
  return {
    action: "MAKE",
    classification: primary.classification,
    headline: `${net.legs[0].out.name} → ${net.legs[0].incoming.name}`,
    reason: primary.reason,
    confidence: net.confidence,
    risk: net.risk,
    hitLabel: net.hitLabel,
    hitCost: net.hitCost,
    threeGwNetVsHold: net.threeGwNetVsHold,
    fiveGwNetVsHold: net.fiveGwNetVsHold,
    riskAdjustedFiveGwNetVsHold: net.riskAdjustedFiveGwNetVsHold,
    alternative,
    recommendation: primary,
  };
}

/**
 * Full Mohamed transfer recommendation engine (type-B HOLD).
 * Ranks by risk-adjusted 5-GW NET vs HOLD (best future plan after transfer-now
 * minus best future plan after hold-now). Projection weights unchanged.
 *
 * Non-blocking: week-0 pairs cheap-prefiltered to maxEvalCandidates; shared
 * planTimeBudgetMs / maxPlanNodes abort runaway work. Overview / mode:'shallow'
 * forces futureBeamWidth 0 so sync first paint cannot run deep multi-GW search.
 * Transfers uses mode:'deep' deferred via requestIdleCallback after paint.
 */
/** Last plan budget from recommendTransfers — test/debug only. */
let _lastPlanBudget: import("./plan").PlanBudget | null = null;
export function getLastPlanBudgetForTests(): import("./plan").PlanBudget | null {
  return _lastPlanBudget;
}

export function recommendTransfers(
  data: FplData,
  squad: FplPlayer[],
  bank: number,
  freeTransfers = 1,
  sellingPrices: Map<number, number> = new Map(),
  options: TransferEngineOptions = {},
): TransferEngineResult {
  // Hang prevention: mode:'shallow' (Overview) forces futureBeamWidth/beamWidth 0.
  const shallowRequested = options.mode === "shallow";
  const baseOverrides: Partial<TransferEngineRules> = {
    ...(shallowRequested ? OVERVIEW_TRANSFER_RULES : {}),
    ...(options.rules ?? {}),
  };
  if (shallowRequested) {
    baseOverrides.futureBeamWidth = 0;
    baseOverrides.beamWidth = 0;
  }
  const rules = mergeTransferRules(baseOverrides);
  if (shallowRequested && !isShallowPlanning(rules)) {
    throw new Error("transfer-engine: mode:'shallow' must keep futureBeamWidth at 0");
  }
  const limit = Math.max(1, options.limit ?? rules.resultLimit);
  const emptyRoll = (reason: string): TransferEngineResult => {
    const rollCard = buildRecommendationCard("HOLD", reason, null);
    return {
      rules,
      hold: {
        kind: "HOLD",
        planner: "type-B",
        weeklyGross: [],
        weeklyDiscounted: [],
        discountedTotal: 0,
        undiscountedTotal: 0,
        freeTransfersPath: [],
        pathSummary: [],
      },
      primary: null,
      bestDecision: null,
      recommendations: [],
      rollCard,
    };
  };

  if (!isCompleteSquad(squad, data)) {
    return emptyRoll("Squad is incomplete — connect or build a full 15 before ranking transfers.");
  }

  const state = createTeamState(squad, bank, freeTransfers, sellingPrices, rules);
  const events = futureEvents(data, rules.horizonGw);
  if (!events.length) return emptyRoll("No future gameweek to project against.");

  const first = events[0].id;
  const projectionCache = new Map<string, number>();
  const project = (player: FplPlayer, eventId: number) => {
    const key = `${player.id}:${eventId}`;
    if (!projectionCache.has(key)) {
      projectionCache.set(key, playerProjection(player, eventId, data.fixtures, first));
    }
    return projectionCache.get(key)!;
  };
  const metricCache = new Map<string, ReturnType<typeof projectionMetrics>>();
  const metrics = (player: FplPlayer, eventId: number) => {
    const key = `${player.id}:${eventId}`;
    if (!metricCache.has(key)) {
      metricCache.set(key, projectionMetrics(player, eventId, data.fixtures, first));
    }
    return metricCache.get(key)!;
  };

  const pools = scoreCandidatePool(data, events, first, project, metrics, rules);
  const budget = createPlanBudget(rules);
  _lastPlanBudget = budget;
  const shallowFuture = isShallowPlanning(rules);
  const maxEval = Math.max(1, rules.maxEvalCandidates);

  // Type-B HOLD baseline: no transfer NOW, bank FT, allow future free transfers
  // (future beam may be 0 on Overview — still banks FT; no deep continuation search).
  const holdPlan = bestFuturePlan(state, data, events, first, pools, project, rules, [], budget);
  const hold: HoldBaseline = {
    kind: "HOLD",
    planner: "type-B",
    weeklyGross: holdPlan.steps.map((s) => s.grossEp),
    weeklyDiscounted: holdPlan.steps.map((s) => s.discountedEp),
    discountedTotal: holdPlan.discountedTotal,
    undiscountedTotal: holdPlan.undiscountedTotal,
    freeTransfersPath: holdPlan.freeTransfersPath,
    pathSummary: summarizePlanPath(holdPlan),
  };

  // Cheap pre-rank week-0 pairs so we never full-plan the entire candidate×squad matrix.
  type Pair = { out: FplPlayer; incoming: FplPlayer; cheap: number };
  const pairs: Pair[] = [];
  for (const out of state.squad) {
    const pool = pools.get(out.positionId) ?? [];
    for (const incoming of pool) {
      if (incoming.id === out.id) continue;
      const legal = isLegalSingleTransfer(
        data, state.squad, out, incoming, state.bank, state.sellingPrices, rules,
      );
      if (!legal.legal) continue;
      const hitCost = exactHitCost(1, state.freeTransfers, rules);
      if (hitCost > rules.maxWeek1Hit) continue;
      let cheap = 0;
      for (let i = 0; i < events.length; i++) {
        const d = rules.horizonDiscounts[i] ?? 1;
        cheap += (project(incoming, events[i].id) - project(out, events[i].id)) * d;
      }
      cheap -= hitCost;
      pairs.push({ out, incoming, cheap });
    }
  }
  pairs.sort((a, b) => b.cheap - a.cheap);
  const toEval = pairs.slice(0, maxEval);

  const nets: TransferNetEV[] = [];
  const timingSlots = shallowFuture ? 0 : Math.min(6, toEval.length);
  for (let idx = 0; idx < toEval.length; idx++) {
    if (!budgetOk(budget)) break;
    const { out, incoming } = toEval[idx];
    const computeTiming = idx < timingSlots;
    const net = evaluateSingleMove(
      data, state, holdPlan, hold, out, incoming, events, first, project, pools, rules,
      budget, computeTiming,
    );
    if (net) nets.push(net);
  }

  const moveRecs: TransferRecommendation[] = nets
    .map((net) => {
      const { classification, reason, reasonCodes } = classifyTransfer({ net }, rules);
      net.reasonCodes = reasonCodes;
      return {
        classification,
        reason,
        net,
        card: buildRecommendationCard(classification, reason, net),
      };
    })
    .sort(
      (a, b) =>
        b.net.riskAdjustedFiveGwNetVsHold - a.net.riskAdjustedFiveGwNetVsHold ||
        b.net.fiveGwNetVsHold - a.net.fiveGwNetVsHold ||
        a.net.hitCost - b.net.hitCost ||
        b.net.bankAfter - a.net.bankAfter,
    );

  const holdRec = buildHoldRecommendation(state, hold, holdPlan, first, data);
  const includeHold = options.includeHold !== false;
  const combined = includeHold ? [...moveRecs, holdRec] : [...moveRecs];
  combined.sort(
    (a, b) =>
      b.net.riskAdjustedFiveGwNetVsHold - a.net.riskAdjustedFiveGwNetVsHold ||
      b.net.fiveGwNetVsHold - a.net.fiveGwNetVsHold ||
      a.net.hitCost - b.net.hitCost ||
      (a.classification === "HOLD" ? -1 : 0) - (b.classification === "HOLD" ? -1 : 0) ||
      b.net.bankAfter - a.net.bankAfter,
  );
  const recommendations = diversifyRecommendations(combined, rules).slice(0, limit);

  const rollCard: TransferRecommendationCard = { ...holdRec.card, reason: holdRec.reason };

  const bestMakeOrLean = recommendations.find(
    (r) => r.classification === "MAKE" || r.classification === "LEAN",
  );
  const holdInRank = recommendations.find((r) => r.classification === "HOLD") ?? holdRec;
  // Primary is MAKE/LEAN only when it beats HOLD on risk-adj NET; otherwise HOLD.
  const primary =
    bestMakeOrLean && bestMakeOrLean.net.riskAdjustedFiveGwNetVsHold > 0
      ? bestMakeOrLean
      : holdInRank;

  const bestDecision = buildBestDecision(primary, recommendations);

  return { rules, hold, primary, bestDecision, recommendations, rollCard, holdPlan };
}

/** Structured JSON for UI / debugging. */
export function recommendationsToJson(result: TransferEngineResult): object {
  return {
    schema: "fpl-edge.transfer-engine.v2",
    planner: "type-B",
    rules: {
      hitPointsPerTransfer: result.rules.hitPointsPerTransfer,
      freeTransferCap: result.rules.freeTransferCap,
      horizonDiscounts: [...result.rules.horizonDiscounts],
      freeMakeNetThreshold: result.rules.freeMakeNetThreshold,
      freeLeanNetThreshold: result.rules.freeLeanNetThreshold,
      hitMakeNetThreshold: result.rules.hitMakeNetThreshold,
      hitLeanNetThreshold: result.rules.hitLeanNetThreshold,
    },
    hold: {
      planner: result.hold.planner,
      discountedTotal: result.hold.discountedTotal,
      undiscountedTotal: result.hold.undiscountedTotal,
      weeklyGross: result.hold.weeklyGross,
      pathSummary: result.hold.pathSummary,
      freeTransfersPath: result.hold.freeTransfersPath,
    },
    roll: result.rollCard,
    primary: result.primary?.card ?? result.rollCard,
    bestDecision: result.bestDecision
      ? {
          action: result.bestDecision.action,
          classification: result.bestDecision.classification,
          headline: result.bestDecision.headline,
          reason: result.bestDecision.reason,
          hitLabel: result.bestDecision.hitLabel,
          threeGwNetVsHold: result.bestDecision.threeGwNetVsHold,
          fiveGwNetVsHold: result.bestDecision.fiveGwNetVsHold,
          riskAdjustedFiveGwNetVsHold: result.bestDecision.riskAdjustedFiveGwNetVsHold,
          confidence: result.bestDecision.confidence,
          risk: result.bestDecision.risk,
          alternative: result.bestDecision.alternative?.card ?? null,
        }
      : null,
    recommendations: result.recommendations.map((r) => r.card),
  };
}
