import type { FplPlayer, ProjectionMetrics } from "../fpl";
import type { TransferEngineRules } from "./rules";

/** Classification for NET-first recommendation cards. */
export type TransferClassification = "MAKE" | "LEAN" | "ROLL" | "WATCH" | "AVOID";

export type TeamState = {
  squad: FplPlayer[];
  bank: number;
  freeTransfers: number;
  sellingPrices: Map<number, number>;
};

export type SquadWeekLineup = {
  eventId: number;
  xi: FplPlayer[];
  captain: FplPlayer | null;
  vice: FplPlayer | null;
  bench: FplPlayer[];
  /** XI sum + captain multiplier (chips NOT included — chips are separate). */
  grossEp: number;
};

export type HoldBaseline = {
  kind: "HOLD" | "ROLL";
  weeklyGross: number[];
  weeklyDiscounted: number[];
  discountedTotal: number;
  undiscountedTotal: number;
  freeTransfersPath: number[];
};

export type TransferLeg = {
  out: FplPlayer;
  incoming: FplPlayer;
  sellingPrice: number;
  buyingPrice: number;
};

/**
 * Net expected value of a transfer plan versus the HOLD/ROLL baseline.
 * Ranking key is riskAdjustedNet5 (discounted, hit-subtracted, risk-adjusted).
 */
export type TransferNetEV = {
  legs: TransferLeg[];
  transferCount: number;
  hitCost: number;
  hitLabel: string;
  bankAfter: number;
  freeTransfersAfter: number;
  /** Next-GW squad gross EP after the move (before hit). */
  nextGwGross: number;
  /** Undiscounted squad EP deltas vs HOLD (gross, before hit). */
  grossDelta1: number;
  grossDelta3: number;
  grossDelta5: number;
  /** Discounted 5-GW squad EP minus hit, minus HOLD discounted total. */
  netEv5: number;
  /** netEv3 (first 3 discounts) minus proportional hit attribution (full hit in week 1). */
  netEv3: number;
  /** Risk-adjusted netEv5 used for ranking / classification. */
  riskAdjustedNet5: number;
  confidence: number;
  risk: "Low" | "Medium" | "High";
  weeklyGrossDeltas: number[];
  outMetrics: ProjectionMetrics;
  inMetrics: ProjectionMetrics;
  /** Individual player projections (audit only — ranking uses squad EP). */
  individualGain1: number;
  individualGain3: number;
  individualGain5: number;
  outGw1: number;
  inGw1: number;
  outGw3: number;
  inGw3: number;
  outGw5: number;
  inGw5: number;
};

export type TransferRecommendation = {
  classification: TransferClassification;
  reason: string;
  net: TransferNetEV;
  /** Structured card payload for UI / JSON. */
  card: TransferRecommendationCard;
};

export type TransferRecommendationCard = {
  classification: TransferClassification;
  outName: string;
  inName: string;
  outId: number;
  inId: number;
  hitLabel: string;
  hitCost: number;
  bankAfter: number;
  nextGwGross: number;
  net3: number;
  net5: number;
  riskAdjustedNet5: number;
  confidence: number;
  risk: "Low" | "Medium" | "High";
  reason: string;
};

export type TransferEngineResult = {
  rules: TransferEngineRules;
  hold: HoldBaseline;
  /** Primary decision: often a ROLL card when nothing clears MAKE/LEAN. */
  primary: TransferRecommendation | null;
  recommendations: TransferRecommendation[];
  /** Explicit ROLL card always present for UI baseline. */
  rollCard: TransferRecommendationCard;
};

export type TransferEngineOptions = {
  rules?: Partial<TransferEngineRules>;
  limit?: number;
  /** Max transfers in the week-1 action being scored (1 or 2). */
  maxTransfersWeek1?: 1 | 2;
};
