import type { FplData, FplPlayer } from "../fpl";
import { playerCalibrationProfile } from "../fpl";
import { classifyFiveGwGain, transferAnomalies } from "../anomalies";
import { evaluateTransferQuality } from "../transfer-quality";
import { classificationToLegacyQuality } from "./classify";
import { recommendTransfers } from "./recommend";
import type { TransferClassification, TransferEngineOptions, TransferRecommendation } from "./types";

/**
 * Engine-ranked transfer row. Structurally compatible with legacy `Transfer`
 * in app/lib/transfers.ts, plus NET-first classification fields.
 * Deliberately does not import Transfer (avoids circular dependency).
 */
export type EngineTransfer = {
  out: FplPlayer;
  incoming: FplPlayer;
  gain1: number;
  gain3: number;
  gain5: number;
  individualGain1: number;
  individualGain3: number;
  individualGain5: number;
  outGw1: number;
  inGw1: number;
  outGw3: number;
  inGw3: number;
  outGw5: number;
  inGw5: number;
  price: number;
  minutes: number;
  expectedMinutesOut: number;
  expectedMinutesIn: number;
  startProbOut: number;
  startProbIn: number;
  dcOut: number;
  dcIn: number;
  attackingOut: number;
  attackingIn: number;
  fixtureAdjustmentIn: number;
  confidenceOut: number;
  confidenceIn: number;
  teamAttackIn: number;
  teamDefenceIn: number;
  opponentDefenceIn: number;
  opponentAttackIn: number;
  fixtureAttackMultiplierIn: number;
  fixtureDefenceMultiplierIn: number;
  outMetrics: ReturnType<typeof import("../fpl").projectionMetrics>;
  inMetrics: ReturnType<typeof import("../fpl").projectionMetrics>;
  gainBand: ReturnType<typeof classifyFiveGwGain>;
  anomalies: ReturnType<typeof transferAnomalies>;
  hitCost: number;
  netDifference: number;
  utilityChange: number | null;
  rankScore: number;
  reviewRequired: boolean;
  weeklyGains: number[];
  positiveWeeks: number;
  gainWithoutBestWeek: number;
  qualityStatus: "actionable" | "watchlist" | "blocked";
  qualityScore: number;
  qualityReasons: { code: string; message: string }[];
  risk: "Low" | "Medium" | "High";
  classification: TransferClassification;
  engineReason: string;
  netEv3: number;
  netEv5: number;
  riskAdjustedNet5: number;
  bankAfter: number;
  hitLabel: string;
  nextGwGross: number;
  /** Explicit HOLD / NO TRANSFER ranked option. */
  isHold?: boolean;
};


/** Prefer the live FplPlayer from data.players so UI fields like priceOutlook are never stripped. */
function resolveEnginePlayer(player: FplPlayer, byId?: Map<number, FplPlayer>): FplPlayer {
  const full = byId?.get(player.id);
  if (full) return full;
  if (Array.isArray(player.priceOutlook)) return player;
  return {
    ...player,
    priceOutlook: [],
    priceProjectionToday: player.priceProjectionToday ?? 0,
  };
}

export function recommendationToTransfer(rec: TransferRecommendation, playersById?: Map<number, FplPlayer>): EngineTransfer | null {
  const net = rec.net;
  if (!net.legs.length) {
    if (rec.classification !== "HOLD" && rec.classification !== "ROLL") return null;
    // Minimal UI-safe FplPlayer shape: PriceIntel / priceOutlookSignal iterate priceOutlook.
    const stub = {
      id: 0,
      name: "HOLD",
      positionShort: "MID",
      price: 0,
      teamShort: "—",
      teamId: 0,
      priceProjectionToday: 0,
      priceOutlook: [],
    } as unknown as FplPlayer;
    const stubIn = { ...stub, name: "NO TRANSFER" } as unknown as FplPlayer;
    return {
      out: stub,
      incoming: stubIn,
      gain1: 0, gain3: 0, gain5: 0,
      individualGain1: 0, individualGain3: 0, individualGain5: 0,
      outGw1: 0, inGw1: 0, outGw3: 0, inGw3: 0, outGw5: 0, inGw5: 0,
      price: 0, minutes: 0, expectedMinutesOut: 0, expectedMinutesIn: 0,
      startProbOut: 1, startProbIn: 1, dcOut: 0, dcIn: 0,
      attackingOut: 0, attackingIn: 0, fixtureAdjustmentIn: 3,
      confidenceOut: 1, confidenceIn: 1,
      teamAttackIn: 1, teamDefenceIn: 1, opponentDefenceIn: 1, opponentAttackIn: 1,
      fixtureAttackMultiplierIn: 1, fixtureDefenceMultiplierIn: 1,
      outMetrics: net.outMetrics, inMetrics: net.inMetrics,
      gainBand: classifyFiveGwGain(0),
      anomalies: [],
      hitCost: 0,
      netDifference: 0,
      utilityChange: null,
      rankScore: 0,
      reviewRequired: false,
      weeklyGains: net.weeklyGrossDeltas,
      positiveWeeks: 0,
      gainWithoutBestWeek: 0,
      qualityStatus: "watchlist",
      qualityScore: 100,
      qualityReasons: [{ code: "engine-hold", message: rec.reason }],
      risk: "Low",
      classification: "HOLD",
      engineReason: rec.reason,
      netEv3: 0,
      netEv5: 0,
      riskAdjustedNet5: 0,
      bankAfter: net.bankAfter,
      hitLabel: "Free",
      nextGwGross: net.nextGwGross,
      isHold: true,
    };
  }
  const out = resolveEnginePlayer(net.legs[0].out, playersById);
  const incoming = resolveEnginePlayer(net.legs[0].incoming, playersById);
  const om = net.outMetrics;
  const im = net.inMetrics;
  const gain1 = net.grossDelta1;
  const gain3 = net.grossDelta3;
  const gain5 = net.grossDelta5;
  const anomalies = transferAnomalies(out, incoming, gain5, om, im);
  const calibration = playerCalibrationProfile(incoming);
  const quality = evaluateTransferQuality({
    gain1,
    gain3,
    gain5,
    weeklyGains: net.weeklyGrossDeltas,
    expectedMinutes: im.expectedMinutes,
    startProbability: im.startProbability,
    confidence: im.confidence,
    calibrationGroup: calibration.group,
    lowPlContinuityClub: calibration.lowPlContinuityClub,
    anomalyCodes: anomalies.map((flag) => flag.code),
  });

  const legacyStatus = classificationToLegacyQuality(rec.classification);
  // Engine classification drives ranking; hard quality blocks still demote.
  let qualityStatus = legacyStatus;
  if (quality.status === "blocked" && legacyStatus === "actionable") qualityStatus = "watchlist";
  if (rec.classification === "AVOID") qualityStatus = "blocked";

  return {
    out,
    incoming,
    gain1,
    gain3,
    gain5,
    individualGain1: net.individualGain1,
    individualGain3: net.individualGain3,
    individualGain5: net.individualGain5,
    outGw1: net.outGw1,
    inGw1: net.inGw1,
    outGw3: net.outGw3,
    inGw3: net.inGw3,
    outGw5: net.outGw5,
    inGw5: net.inGw5,
    price: incoming.price - out.price,
    minutes: im.expectedMinutes - om.expectedMinutes,
    expectedMinutesOut: om.expectedMinutes,
    expectedMinutesIn: im.expectedMinutes,
    startProbOut: om.startProbability,
    startProbIn: im.startProbability,
    dcOut: om.defensiveContribution,
    dcIn: im.defensiveContribution,
    attackingOut: om.xG + om.xA,
    attackingIn: im.xG + im.xA,
    fixtureAdjustmentIn: 3,
    confidenceOut: om.confidence,
    confidenceIn: im.confidence,
    teamAttackIn: im.teamAttackFactor ?? 1,
    teamDefenceIn: im.teamDefenceFactor ?? 1,
    opponentDefenceIn: im.opponentDefenceFactor ?? 1,
    opponentAttackIn: im.opponentAttackFactor ?? 1,
    fixtureAttackMultiplierIn: im.fixtureAttackMultiplier ?? 1,
    fixtureDefenceMultiplierIn: im.fixtureDefenceMultiplier ?? 1,
    outMetrics: om,
    inMetrics: im,
    gainBand: classifyFiveGwGain(gain5),
    anomalies,
    hitCost: net.hitCost,
    netDifference: net.netEv5,
    utilityChange: null,
    rankScore: net.riskAdjustedNet5,
    reviewRequired: qualityStatus === "blocked" || rec.classification === "AVOID",
    weeklyGains: net.weeklyGrossDeltas,
    positiveWeeks: quality.positiveWeeks,
    gainWithoutBestWeek: quality.gainWithoutBestWeek,
    qualityStatus,
    qualityScore: quality.score,
    qualityReasons: [
      { code: `engine-${rec.classification.toLowerCase()}`, message: rec.reason },
      ...quality.reasons,
    ],
    risk: net.risk,
    classification: rec.classification,
    engineReason: rec.reason,
    netEv3: net.netEv3,
    netEv5: net.netEv5,
    riskAdjustedNet5: net.riskAdjustedNet5,
    bankAfter: net.bankAfter,
    hitLabel: net.hitLabel,
    nextGwGross: net.nextGwGross,
  };
}

export function bestTransfersFromEngine(
  data: FplData,
  squad: FplPlayer[],
  bank: number,
  freeTransfers = 1,
  limit = 12,
  sellingPrices: Map<number, number> = new Map(),
  options: TransferEngineOptions = {},
): EngineTransfer[] {
  const result = recommendTransfers(data, squad, bank, freeTransfers, sellingPrices, {
    ...options,
    limit,
  });
  const playersById = new Map(data.players.map((player) => [player.id, player]));
  return result.recommendations
    .map((rec) => recommendationToTransfer(rec, playersById))
    .filter((row): row is EngineTransfer => row !== null);
}

export function selectPrimaryEngineTransfer(rows: EngineTransfer[]): EngineTransfer | null {
  return (
    rows.find((row) => row.classification === "MAKE") ??
    rows.find((row) => row.classification === "LEAN") ??
    null
  );
}
