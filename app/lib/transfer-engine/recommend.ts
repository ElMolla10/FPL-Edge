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
  TransferEngineRules,
  clampFreeTransfers,
  exactHitCost,
  hitLabel,
  mergeTransferRules,
} from "./rules";
import { isLegalSingleTransfer, sellingPriceFor } from "./legality";
import { buildRecommendationCard, classifyTransfer } from "./classify";
import {
  applyLegsToState,
  buildHoldBaseline,
  discountedSquadEp,
  optimalSquadWeek,
} from "./squad-ep";
import type {
  HoldBaseline,
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
  hold: HoldBaseline,
  out: FplPlayer,
  incoming: FplPlayer,
  events: { id: number }[],
  first: number,
  project: (p: FplPlayer, e: number) => number,
  rules: TransferEngineRules,
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
  const ep = discountedSquadEp(
    nextState.squad,
    events,
    data,
    first,
    rules.horizonDiscounts,
    project,
  );

  const weeklyGrossDeltas = ep.weeklyGross.map((pts, i) => pts - hold.weeklyGross[i]);
  const grossDelta1 = weeklyGrossDeltas[0] ?? 0;
  const grossDelta3 = weeklyGrossDeltas.slice(0, 3).reduce((a, b) => a + b, 0);
  const grossDelta5 = weeklyGrossDeltas.reduce((a, b) => a + b, 0);

  // Hit is charged in week 1 only (exact FPL). NET = discounted post-move EP − hit − HOLD.
  const netEv5 = ep.discountedTotal - hitCost - hold.discountedTotal;
  const discounted3 =
    ep.weeklyDiscounted.slice(0, 3).reduce((a, b) => a + b, 0) -
    hold.weeklyDiscounted.slice(0, 3).reduce((a, b) => a + b, 0);
  const netEv3 = discounted3 - hitCost;

  const om = projectionMetrics(out, first, data.fixtures, first);
  const im = projectionMetrics(incoming, first, data.fixtures, first);
  const outByEvent = events.map((e) => project(out, e.id));
  const inByEvent = events.map((e) => project(incoming, e.id));
  const sum = (arr: number[], n?: number) =>
    (n === undefined ? arr : arr.slice(0, n)).reduce((a, b) => a + b, 0);

  const mult = riskMultiplier(im.startProbability, im.confidence);
  const riskAdjustedNet5 = (netEv5 > 0 ? netEv5 * mult : netEv5);

  const confidence = clamp(0.35 * im.startProbability + 0.35 * im.confidence + 0.3 * clamp(im.expectedMinutes / 90, 0, 1), 0, 1);
  const risk: TransferNetEV["risk"] =
    im.startProbability > 0.8 && im.startProbability >= om.startProbability
      ? "Low"
      : im.startProbability > 0.62
        ? "Medium"
        : "High";

  const nextGwGross = optimalSquadWeek(nextState.squad, first, data, first, project).grossEp;

  return {
    legs: [leg],
    transferCount: 1,
    hitCost,
    hitLabel: hitLabel(hitCost, rules),
    bankAfter: nextState.bank,
    freeTransfersAfter: nextState.freeTransfers,
    nextGwGross,
    grossDelta1,
    grossDelta3,
    grossDelta5,
    netEv5,
    netEv3,
    riskAdjustedNet5,
    confidence,
    risk,
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
  };
}


/**
 * Cap clusters that share the same outgoing or incoming player so one family
 * (e.g. O'Nien → Bogle/Mitchell/Mykolenko) cannot dominate the top N.
 * Already-sorted by riskAdjustedNet5 descending.
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

function buildHoldRecommendation(
  state: TeamState,
  hold: HoldBaseline,
  first: number,
  data: FplData,
): TransferRecommendation {
  const { classification, reason } = classifyTransfer({ isHold: true });
  const net: TransferNetEV = {
    legs: [],
    transferCount: 0,
    hitCost: 0,
    hitLabel: "Free",
    bankAfter: state.bank,
    freeTransfersAfter: state.freeTransfers,
    nextGwGross: hold.weeklyGross[0] ?? 0,
    grossDelta1: 0,
    grossDelta3: 0,
    grossDelta5: 0,
    netEv5: 0,
    netEv3: 0,
    riskAdjustedNet5: 0,
    confidence: 1,
    risk: "Low",
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
      net3: 0,
      net5: 0,
      riskAdjustedNet5: 0,
      confidence: 1,
      risk: "Low",
      outName: "HOLD",
      inName: "NO TRANSFER",
      reason,
    },
  };
}

/**
 * Full Mohamed transfer recommendation engine.
 * Ranks by risk-adjusted 5-GW NET vs HOLD (discounted squad EP, exact hits, selling prices).
 */
export function recommendTransfers(
  data: FplData,
  squad: FplPlayer[],
  bank: number,
  freeTransfers = 1,
  sellingPrices: Map<number, number> = new Map(),
  options: TransferEngineOptions = {},
): TransferEngineResult {
  const rules = mergeTransferRules(options.rules);
  const limit = Math.max(1, options.limit ?? rules.resultLimit);
  const emptyRoll = (reason: string): TransferEngineResult => {
    const rollCard = buildRecommendationCard("HOLD", reason, null);
    return {
      rules,
      hold: {
        kind: "HOLD",
        weeklyGross: [],
        weeklyDiscounted: [],
        discountedTotal: 0,
        undiscountedTotal: 0,
        freeTransfersPath: [],
      },
      primary: null,
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

  const hold = buildHoldBaseline(state, data, rules, project);
  if (!hold) return emptyRoll("No future gameweek to project against.");

  const pools = scoreCandidatePool(data, events, first, project, metrics, rules);
  const nets: TransferNetEV[] = [];

  for (const out of state.squad) {
    const pool = pools.get(out.positionId) ?? [];
    for (const incoming of pool) {
      if (incoming.id === out.id) continue;
      const net = evaluateSingleMove(data, state, hold, out, incoming, events, first, project, rules);
      if (net) nets.push(net);
    }
  }

  // Also allow affordable high-epNext players not in the role-security pool (caught as WATCH/AVOID).
  // Keeps audit visibility without polluting MAKE rankings — classify() gates them.

  const moveRecs: TransferRecommendation[] = nets
    .map((net) => {
      const { classification, reason } = classifyTransfer({ net }, rules);
      return {
        classification,
        reason,
        net,
        card: buildRecommendationCard(classification, reason, net),
      };
    })
    .sort(
      (a, b) =>
        b.net.riskAdjustedNet5 - a.net.riskAdjustedNet5 ||
        b.net.netEv5 - a.net.netEv5 ||
        a.net.hitCost - b.net.hitCost ||
        b.net.bankAfter - a.net.bankAfter,
    );

  const holdRec = buildHoldRecommendation(state, hold, first, data);
  const includeHold = options.includeHold !== false;
  // Rank HOLD (NET 0) alongside moves so hit-adjusted poor nets surface HOLD on top.
  const combined = includeHold ? [...moveRecs, holdRec] : [...moveRecs];
  combined.sort(
    (a, b) =>
      b.net.riskAdjustedNet5 - a.net.riskAdjustedNet5 ||
      b.net.netEv5 - a.net.netEv5 ||
      a.net.hitCost - b.net.hitCost ||
      (a.classification === "HOLD" ? -1 : 0) - (b.classification === "HOLD" ? -1 : 0) ||
      b.net.bankAfter - a.net.bankAfter,
  );
  const recommendations = diversifyRecommendations(combined, rules).slice(0, limit);

  const rollReason = holdRec.reason;
  const rollCard: TransferRecommendationCard = {
    ...holdRec.card,
    reason: rollReason,
  };

  const bestMakeOrLean = recommendations.find(
    (r) => r.classification === "MAKE" || r.classification === "LEAN",
  );
  const holdInRank = recommendations.find((r) => r.classification === "HOLD") ?? holdRec;
  // Primary is MAKE/LEAN only when it beats HOLD on risk-adj NET; otherwise HOLD/NO TRANSFER.
  const primary =
    bestMakeOrLean && bestMakeOrLean.net.riskAdjustedNet5 > 0
      ? bestMakeOrLean
      : holdInRank;

  return { rules, hold, primary, recommendations, rollCard };
}

/** Structured JSON for UI / debugging. */
export function recommendationsToJson(result: TransferEngineResult): object {
  return {
    schema: "fpl-edge.transfer-engine.v1",
    rules: {
      hitPointsPerTransfer: result.rules.hitPointsPerTransfer,
      freeTransferCap: result.rules.freeTransferCap,
      horizonDiscounts: [...result.rules.horizonDiscounts],
      makeNetThreshold: result.rules.makeNetThreshold,
      leanNetThreshold: result.rules.leanNetThreshold,
    },
    hold: {
      discountedTotal: result.hold.discountedTotal,
      undiscountedTotal: result.hold.undiscountedTotal,
      weeklyGross: result.hold.weeklyGross,
    },
    roll: result.rollCard,
    primary: result.primary?.card ?? result.rollCard,
    recommendations: result.recommendations.map((r) => r.card),
  };
}
