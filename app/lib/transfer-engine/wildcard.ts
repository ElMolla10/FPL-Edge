/**
 * Wildcard Optimization — transfer suggestions while Wildcard is active.
 *
 * Hard rules vs the normal transfer engine:
 * - Do NOT use available FT count as a constraint.
 * - Do NOT apply hit costs (−4 / −8).
 * - Do NOT evaluate NET vs type-B HOLD (bank FT) in the normal sense.
 * - Do NOT label moves as "Free transfer."
 * - Rank single-player swaps as temporary Wildcard squad-optimization decisions
 *   at full-squad objective level (3/5/8 GW projections, minutes, xG/xA, fixtures,
 *   set pieces, price/bank enablement, structure, bench).
 *
 * Non-Wildcard callers must continue to use recommendTransfers() unchanged.
 */

import {
  FplData,
  FplPlayer,
  ROLE_SECURITY_FLOOR,
  futureEvents,
  isCompleteSquad,
  playerProjection,
  projectionMetrics,
} from "../fpl";
import { createOptimizer } from "../optimizer";
import { isLegalSingleTransfer, sellingPriceFor } from "./legality";
import { buildRecommendationCard } from "./classify";
import { DEFAULT_TRANSFER_RULES_2026_27, mergeTransferRules, type TransferEngineRules } from "./rules";
import type {
  BestDecision,
  HoldBaseline,
  RiskDriver,
  TransferEngineOptions,
  TransferEngineResult,
  TransferLeg,
  TransferNetEV,
  TransferRecommendation,
  TransferRecommendationCard,
} from "./types";

const money = (value: number) => Math.round((value + Number.EPSILON) * 10) / 10;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/** Hit label while Wildcard is active — never "Free". */
export const WILDCARD_HIT_LABEL = "Wildcard";

export type WildcardSwapAxes = {
  squadObjectiveDelta: number;
  threeGwPointsDelta: number;
  fiveGwPointsDelta: number;
  eightGwPointsDelta: number;
  bankAfter: number;
  bankDelta: number;
  startProbIn: number;
  startProbOut: number;
  expectedMinutesIn: number;
  expectedMinutesOut: number;
  xGIn: number;
  xAIn: number;
  xGOut: number;
  xAOut: number;
  setPieceIn: boolean;
  setPieceOut: boolean;
  fixtureDifficultyIn: number;
  formation: string;
  benchSpendDelta: number;
};

function buildAxesReason(out: FplPlayer, incoming: FplPlayer, axes: WildcardSwapAxes): { reason: string; codes: string[] } {
  const codes: string[] = ["wildcard-squad-opt"];
  const bits: string[] = [];

  bits.push(
    `Wildcard swap candidate: full-squad objective ${axes.squadObjectiveDelta >= 0 ? "+" : ""}${axes.squadObjectiveDelta.toFixed(2)} vs current temporary squad.`,
  );

  bits.push(
    `Projected squad points Δ: 3GW ${fmt(axes.threeGwPointsDelta)}, 5GW ${fmt(axes.fiveGwPointsDelta)}, 8GW ${fmt(axes.eightGwPointsDelta)}.`,
  );
  codes.push("horizon-points");

  bits.push(
    `Minutes / fitness: ${incoming.name} ${Math.round(axes.startProbIn * 100)}% start · ${Math.round(axes.expectedMinutesIn)} xMins vs ${out.name} ${Math.round(axes.startProbOut * 100)}% · ${Math.round(axes.expectedMinutesOut)}.`,
  );
  codes.push("minutes-security");

  bits.push(
    `Underlying: in xG ${axes.xGIn.toFixed(2)} / xA ${axes.xAIn.toFixed(2)} vs out xG ${axes.xGOut.toFixed(2)} / xA ${axes.xAOut.toFixed(2)}.`,
  );
  codes.push("underlying-xg-xa");

  if (axes.setPieceIn && !axes.setPieceOut) {
    bits.push(`${incoming.name} adds penalty/set-piece involvement.`);
    codes.push("set-pieces");
  } else if (!axes.setPieceIn && axes.setPieceOut) {
    bits.push(`Loses ${out.name}'s set-piece involvement.`);
    codes.push("set-pieces-loss");
  }

  bits.push(`Fixture quality (incoming modelled difficulty ${axes.fixtureDifficultyIn.toFixed(1)}).`);
  codes.push("fixture-quality");

  if (axes.bankDelta > 0.05) {
    bits.push(
      `Downgrade frees £${axes.bankDelta.toFixed(1)}m bank (to £${axes.bankAfter.toFixed(1)}m) for elsewhere in the Wildcard rebuild.`,
    );
    codes.push("bank-enablement");
  } else if (axes.bankDelta < -0.05) {
    bits.push(`Uses £${(-axes.bankDelta).toFixed(1)}m of bank (after £${axes.bankAfter.toFixed(1)}m).`);
    codes.push("bank-spend");
  }

  bits.push(`Squad structure → ${axes.formation}; bench spend Δ ${fmt(axes.benchSpendDelta)}.`);
  codes.push("squad-structure");

  bits.push("Unlimited Wildcard changes allowed until the deadline — current squad is temporary.");
  codes.push("temporary-squad");

  return { reason: bits.join(" "), codes };
}

function fmt(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;
}

function classifyWildcardSwap(
  axes: WildcardSwapAxes,
  inMetrics: ReturnType<typeof projectionMetrics>,
  rules: TransferEngineRules,
): { classification: TransferRecommendation["classification"]; reasonPrefix: string } {
  const roleWeak =
    inMetrics.startProbability < rules.watchStartProbability ||
    inMetrics.expectedMinutes < rules.watchExpectedMinutes ||
    inMetrics.confidence < rules.watchConfidence;
  if (roleWeak) {
    return {
      classification: "AVOID",
      reasonPrefix: "Incoming role security is too weak for a Wildcard slot.",
    };
  }

  const score = axes.squadObjectiveDelta;
  // Thresholds reuse FREE-band magnitudes but apply to full-squad objective Δ (not NET vs HOLD).
  if (score >= rules.freeMakeNetThreshold) {
    return { classification: "MAKE", reasonPrefix: "Clear full-squad Wildcard upgrade." };
  }
  if (score >= rules.freeLeanNetThreshold) {
    return { classification: "LEAN", reasonPrefix: "Positive Wildcard squad edge, thinner than MAKE." };
  }
  if (score >= rules.freeWatchNetThreshold) {
    return { classification: "WATCH", reasonPrefix: "Thin Wildcard edge — watch before locking." };
  }
  if (score > -rules.freeHoldBand) {
    return { classification: "WATCH", reasonPrefix: "Near-zero squad objective change on Wildcard." };
  }
  return { classification: "AVOID", reasonPrefix: "Full-squad objective worsens under Wildcard." };
}

function riskDriversFor(
  out: FplPlayer,
  incoming: FplPlayer,
  om: ReturnType<typeof projectionMetrics>,
  im: ReturnType<typeof projectionMetrics>,
): RiskDriver[] {
  const drivers: RiskDriver[] = [];
  if (im.startProbability < 0.8) {
    drivers.push({
      code: "start-prob",
      label: "Start probability",
      detail: `Incoming start chance ${Math.round(im.startProbability * 100)}%.`,
    });
  }
  if (im.expectedMinutes < 70) {
    drivers.push({
      code: "minutes",
      label: "Expected minutes",
      detail: `Incoming expected minutes ${Math.round(im.expectedMinutes)}.`,
    });
  }
  if (im.confidence < 0.55) {
    drivers.push({
      code: "evidence",
      label: "Projection evidence",
      detail: `Evidence strength ${Math.round(im.confidence * 100)}%.`,
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

function emptyHoldBaseline(bank: number): HoldBaseline {
  return {
    kind: "HOLD",
    planner: "type-B",
    weeklyGross: [],
    weeklyDiscounted: [],
    discountedTotal: 0,
    undiscountedTotal: 0,
    freeTransfersPath: [],
    pathSummary: ["Wildcard active — KEEP means leave this temporary squad unchanged (not a type-B FT HOLD)."],
  };
}

function stubMetrics(_first: number): ReturnType<typeof projectionMetrics> {
  // Minimal stub for KEEP card — never used for ranking.
  return {
    xPts: 0,
    expectedMinutes: 90,
    startProbability: 1,
    sixtyProbability: 1,
    rotationRisk: 0,
    xG: 0,
    xA: 0,
    xG90: 0,
    xA90: 0,
    cleanSheetProbability: 0,
    bonus: 0,
    defensiveContribution: 0,
    saves: 0,
    penaltyRole: false,
    setPieceRole: false,
    confidence: 1,
  };
}

/**
 * Recommend single-player Wildcard swap candidates ranked by full-squad objective Δ.
 * Hit cost is always 0; FT count is ignored; no type-B HOLD banking.
 */
export function recommendWildcardSwaps(
  data: FplData,
  squad: FplPlayer[],
  bank: number,
  sellingPrices: Map<number, number> = new Map(),
  options: TransferEngineOptions = {},
): TransferEngineResult {
  const rules = mergeTransferRules(options.rules);
  const limit = Math.max(1, options.limit ?? 12);
  const prices = new Map(sellingPrices);
  for (const player of squad) {
    if (!prices.has(player.id)) prices.set(player.id, sellingPriceFor(player, prices));
  }

  const hold = emptyHoldBaseline(money(bank));
  const rollCard: TransferRecommendationCard = {
    classification: "HOLD",
    outName: "KEEP",
    inName: "CURRENT SQUAD",
    outId: 0,
    inId: 0,
    hitLabel: WILDCARD_HIT_LABEL,
    hitCost: 0,
    bankAfter: money(bank),
    nextGwGross: 0,
    threeGwNetVsHold: 0,
    fiveGwNetVsHold: 0,
    riskAdjustedFiveGwNetVsHold: 0,
    net3: 0,
    net5: 0,
    riskAdjustedNet5: 0,
    confidence: 1,
    risk: "Low",
    reason:
      "Wildcard active — current squad is temporary. KEEP means no swap on this look; unlimited changes remain available until the deadline. Not a free-transfer HOLD.",
    freeTransfersBefore: undefined,
    freeTransfersAfter: undefined,
  };

  if (!isCompleteSquad(squad, data)) {
    return {
      rules,
      hold,
      primary: null,
      bestDecision: null,
      recommendations: [],
      rollCard,
    };
  }

  const events3 = futureEvents(data, 3);
  const events5 = futureEvents(data, 5);
  const events8 = futureEvents(data, 8);
  const first = events5[0]?.id ?? events3[0]?.id ?? data.events.find((e) => e.next)?.id ?? data.events[0]?.id;
  if (!first) {
    return { rules, hold, primary: null, bestDecision: null, recommendations: [], rollCard };
  }

  // Full-squad Wildcard objective (same engine Draft Lab uses for rebuilds).
  const opt5 = createOptimizer(data, "Balanced 5 GWs", "Balanced", "Maximum xPts");
  const opt3 = createOptimizer(data, "Next 3 GWs", "Balanced", "Maximum xPts");
  const opt8 =
    events8.length >= 6
      ? createOptimizer(data, "Long-term 8 GWs", "Balanced", "Maximum xPts")
      : opt5;

  const baseline5 = opt5.evaluate(squad);
  const baseline3 = opt3.evaluate(squad);
  const baseline8 = opt8.evaluate(squad);
  const baselineBank = money(Number.isFinite(bank) ? bank : baseline5.bank);

  const owned = new Set(squad.map((p) => p.id));
  const candidates: TransferRecommendation[] = [];

  const poolByPos = new Map<number, FplPlayer[]>();
  for (const rule of data.rules.positions) {
    const players = data.players
      .filter((p) => p.positionId === rule.id && p.status !== "u" && !owned.has(p.id))
      .filter((p) => {
        const m = projectionMetrics(p, first, data.fixtures, first);
        return (
          m.startProbability >= ROLE_SECURITY_FLOOR.startProbability * 0.85 &&
          m.expectedMinutes >= ROLE_SECURITY_FLOOR.expectedMinutes * 0.85
        );
      })
      .sort((a, b) => {
        const am = projectionMetrics(a, first, data.fixtures, first);
        const bm = projectionMetrics(b, first, data.fixtures, first);
        const aScore =
          events5.reduce((s, e, i) => s + playerProjection(a, e.id, data.fixtures, first) * (1 - i * 0.08), 0) *
          (0.7 + 0.3 * am.startProbability);
        const bScore =
          events5.reduce((s, e, i) => s + playerProjection(b, e.id, data.fixtures, first) * (1 - i * 0.08), 0) *
          (0.7 + 0.3 * bm.startProbability);
        return bScore - aScore || a.price - b.price;
      })
      .slice(0, rules.candidatePoolPerPosition);
    poolByPos.set(rule.id, players);
  }

  for (const out of squad) {
    for (const incoming of poolByPos.get(out.positionId) ?? []) {
      const legal = isLegalSingleTransfer(data, squad, out, incoming, baselineBank, prices, rules);
      if (!legal.legal) continue;

      const nextSquad = squad.map((p) => (p.id === out.id ? incoming : p));
      const after5 = opt5.evaluate(nextSquad);
      const after3 = opt3.evaluate(nextSquad);
      const after8 = opt8.evaluate(nextSquad);

      const bankAfter = money(baselineBank + legal.sellingPrice - incoming.price);
      const bankDelta = money(bankAfter - baselineBank);
      const om = projectionMetrics(out, first, data.fixtures, first);
      const im = projectionMetrics(incoming, first, data.fixtures, first);

      const fixtureGames = data.fixtures.filter(
        (f) => f.event === first && (f.teamH === incoming.teamId || f.teamA === incoming.teamId),
      );
      const fixtureDifficultyIn = fixtureGames.length
        ? fixtureGames.reduce(
            (s, g) => s + (g.teamH === incoming.teamId ? g.teamHDifficulty : g.teamADifficulty),
            0,
          ) / fixtureGames.length
        : 3;

      const axes: WildcardSwapAxes = {
        squadObjectiveDelta: after5.objective - baseline5.objective,
        threeGwPointsDelta: after3.fiveWeekPoints - baseline3.fiveWeekPoints, // Next 3 uses weeks as fiveWeekPoints alias length
        fiveGwPointsDelta: after5.fiveWeekPoints - baseline5.fiveWeekPoints,
        eightGwPointsDelta: after8.fiveWeekPoints - baseline8.fiveWeekPoints,
        bankAfter,
        bankDelta,
        startProbIn: im.startProbability,
        startProbOut: om.startProbability,
        expectedMinutesIn: im.expectedMinutes,
        expectedMinutesOut: om.expectedMinutes,
        xGIn: im.xG,
        xAIn: im.xA,
        xGOut: om.xG,
        xAOut: om.xA,
        setPieceIn: Boolean(im.penaltyRole || im.setPieceRole),
        setPieceOut: Boolean(om.penaltyRole || om.setPieceRole),
        fixtureDifficultyIn,
        formation: after5.strategy.formation,
        benchSpendDelta: after5.strategy.benchSpend - baseline5.strategy.benchSpend,
      };

      // Prefer Next-3 weeks sum when available for threeGwPointsDelta
      if (after3.weeks.length && baseline3.weeks.length) {
        axes.threeGwPointsDelta =
          after3.weeks.reduce((s, w) => s + w.points, 0) - baseline3.weeks.reduce((s, w) => s + w.points, 0);
      }
      if (after8.weeks.length && baseline8.weeks.length) {
        axes.eightGwPointsDelta =
          after8.weeks.reduce((s, w) => s + w.points, 0) - baseline8.weeks.reduce((s, w) => s + w.points, 0);
      }

      const { classification, reasonPrefix } = classifyWildcardSwap(axes, im, rules);
      const { reason: axisReason, codes } = buildAxesReason(out, incoming, axes);
      const reason = `${reasonPrefix} ${axisReason}`;

      const outByEvent = events5.map((e) => playerProjection(out, e.id, data.fixtures, first));
      const inByEvent = events5.map((e) => playerProjection(incoming, e.id, data.fixtures, first));
      const sum = (arr: number[], n?: number) =>
        (n === undefined ? arr : arr.slice(0, n)).reduce((a, b) => a + b, 0);

      const leg: TransferLeg = {
        out,
        incoming,
        sellingPrice: legal.sellingPrice,
        buyingPrice: incoming.price,
      };

      // Map squad objective into NET-shaped fields for UI reuse — never hit-cost or FT banking.
      const fiveGwNet = axes.fiveGwPointsDelta;
      const threeGwNet = axes.threeGwPointsDelta;
      const riskAdj = axes.squadObjectiveDelta;
      const mult = clamp(0.88 + im.confidence * 0.12, 0.88, 1);
      const riskAdjusted = riskAdj > 0 ? riskAdj * mult : riskAdj;

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

      const net: TransferNetEV = {
        legs: [leg],
        transferCount: 1,
        hitCost: 0,
        hitLabel: WILDCARD_HIT_LABEL,
        bankAfter,
        freeTransfersAfter: 0,
        freeTransfersBefore: 0,
        transfersRequired: 1,
        freeTransfersUsed: 0,
        nextGwGross: after5.weeks[0]?.points ?? 0,
        holdNextGwGross: baseline5.weeks[0]?.points ?? 0,
        grossDelta1: (after5.weeks[0]?.points ?? 0) - (baseline5.weeks[0]?.points ?? 0),
        grossDelta3: threeGwNet,
        grossDelta5: fiveGwNet,
        fiveGwNetVsHold: fiveGwNet,
        threeGwNetVsHold: threeGwNet,
        riskAdjustedFiveGwNetVsHold: riskAdjusted,
        netEv5: fiveGwNet,
        netEv3: threeGwNet,
        riskAdjustedNet5: riskAdjusted,
        riskAdjustment: mult,
        confidence,
        risk,
        riskDrivers: riskDriversFor(out, incoming, om, im),
        weeklyGrossDeltas: after5.weeks.map((w, i) => w.points - (baseline5.weeks[i]?.points ?? 0)),
        outMetrics: om,
        inMetrics: im,
        individualGain1: (inByEvent[0] ?? 0) - (outByEvent[0] ?? 0),
        individualGain3: sum(inByEvent, 3) - sum(outByEvent, 3),
        individualGain5: sum(inByEvent, 5) - sum(outByEvent, 5),
        outGw1: outByEvent[0] ?? 0,
        inGw1: inByEvent[0] ?? 0,
        outGw3: sum(outByEvent, 3),
        inGw3: sum(inByEvent, 3),
        outGw5: sum(outByEvent, 5),
        inGw5: sum(inByEvent, 5),
        transferNowPlanTotal: after5.objective,
        holdNowPlanTotal: baseline5.objective,
        timingEvVsWait: null,
        transferNowPath: [
          `Wildcard swap ${out.name} → ${incoming.name} (unlimited until deadline)`,
          `Squad objective ${fmt(axes.squadObjectiveDelta)} · bank £${bankAfter.toFixed(1)}m`,
        ],
        holdNowPath: [
          "Wildcard KEEP — leave temporary squad as-is (not bank FT)",
          "Unlimited further Wildcard changes remain available until the deadline",
        ],
        riskAdjustmentPointsDelta: riskAdjusted - riskAdj,
        reasonCodes: codes,
      };

      candidates.push({
        classification,
        reason,
        net,
        card: buildRecommendationCard(classification, reason, net),
      });
    }
  }

  candidates.sort(
    (a, b) =>
      b.net.riskAdjustedFiveGwNetVsHold - a.net.riskAdjustedFiveGwNetVsHold ||
      b.net.fiveGwNetVsHold - a.net.fiveGwNetVsHold ||
      a.net.legs[0]!.incoming.price - b.net.legs[0]!.incoming.price,
  );

  // Diversify: cap same out / same in
  const seenOut = new Map<number, number>();
  const seenIn = new Map<number, number>();
  const diversified: TransferRecommendation[] = [];
  for (const rec of candidates) {
    const outId = rec.net.legs[0]!.out.id;
    const inId = rec.net.legs[0]!.incoming.id;
    if ((seenOut.get(outId) ?? 0) >= 2) continue;
    if ((seenIn.get(inId) ?? 0) >= 2) continue;
    seenOut.set(outId, (seenOut.get(outId) ?? 0) + 1);
    seenIn.set(inId, (seenIn.get(inId) ?? 0) + 1);
    diversified.push(rec);
    if (diversified.length >= limit) break;
  }

  // KEEP card — not type-B FT HOLD. Include when no MAKE/LEAN, or as baseline option.
  const keepNet: TransferNetEV = {
    legs: [],
    transferCount: 0,
    hitCost: 0,
    hitLabel: WILDCARD_HIT_LABEL,
    bankAfter: baselineBank,
    freeTransfersAfter: 0,
    freeTransfersBefore: 0,
    transfersRequired: 0,
    freeTransfersUsed: 0,
    nextGwGross: baseline5.weeks[0]?.points ?? 0,
    holdNextGwGross: baseline5.weeks[0]?.points ?? 0,
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
    riskDrivers: [],
    weeklyGrossDeltas: baseline5.weeks.map(() => 0),
    outMetrics: stubMetrics(first),
    inMetrics: stubMetrics(first),
    individualGain1: 0,
    individualGain3: 0,
    individualGain5: 0,
    outGw1: 0,
    inGw1: 0,
    outGw3: 0,
    inGw3: 0,
    outGw5: 0,
    inGw5: 0,
    transferNowPlanTotal: baseline5.objective,
    holdNowPlanTotal: baseline5.objective,
    timingEvVsWait: null,
    transferNowPath: [],
    holdNowPath: [
      "Wildcard KEEP — current temporary squad unchanged",
      "Not a free-transfer HOLD; unlimited Wildcard changes remain until deadline",
    ],
    reasonCodes: ["wildcard-keep", "temporary-squad"],
  };

  const keepRec: TransferRecommendation = {
    classification: "HOLD",
    reason: rollCard.reason,
    net: keepNet,
    card: { ...rollCard, nextGwGross: keepNet.nextGwGross },
  };

  const includeKeep = options.includeHold !== false;
  const recommendations = includeKeep ? [...diversified, keepRec] : [...diversified];

  const primary =
    diversified.find((r) => r.classification === "MAKE" || r.classification === "LEAN") ?? null;

  let bestDecision: BestDecision | null = null;
  if (primary) {
    bestDecision = {
      action: "MAKE",
      classification: primary.classification,
      headline: `${primary.net.legs[0]!.out.name} → ${primary.net.legs[0]!.incoming.name}`,
      reason: primary.reason,
      confidence: primary.net.confidence,
      risk: primary.net.risk,
      hitLabel: WILDCARD_HIT_LABEL,
      hitCost: 0,
      threeGwNetVsHold: primary.net.threeGwNetVsHold,
      fiveGwNetVsHold: primary.net.fiveGwNetVsHold,
      riskAdjustedFiveGwNetVsHold: primary.net.riskAdjustedFiveGwNetVsHold,
      alternative: null,
      recommendation: primary,
    };
  } else {
    bestDecision = {
      action: "HOLD",
      classification: "HOLD",
      headline: "KEEP current Wildcard squad",
      reason: keepRec.reason,
      confidence: 1,
      risk: "Low",
      hitLabel: WILDCARD_HIT_LABEL,
      hitCost: 0,
      threeGwNetVsHold: 0,
      fiveGwNetVsHold: 0,
      riskAdjustedFiveGwNetVsHold: 0,
      alternative: diversified.find((r) => r.classification !== "AVOID") ?? null,
      recommendation: keepRec,
    };
  }

  return {
    rules,
    hold,
    primary,
    bestDecision,
    recommendations,
    rollCard: keepRec.card,
  };
}

/** True when engine options request Wildcard Optimization path. */
export function wantsWildcardOptimization(options: TransferEngineOptions | undefined): boolean {
  return Boolean(options && (options as TransferEngineOptions & { wildcardActive?: boolean }).wildcardActive);
}
