import type { FplPlayer, ProjectionMetrics } from "../fpl";
import type { TransferEngineRules } from "./rules";
import type { FuturePlan, PlanPathLeg } from "./plan";

/** Classification for NET-first recommendation cards. */
export type TransferClassification = "MAKE" | "LEAN" | "HOLD" | "ROLL" | "WATCH" | "AVOID";

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
  /** Type-B: HOLD allows future free transfers (not a frozen 5-GW squad). */
  planner: "type-B";
  weeklyGross: number[];
  weeklyDiscounted: number[];
  discountedTotal: number;
  undiscountedTotal: number;
  freeTransfersPath: number[];
  /** Simplified path labels for UI. */
  pathSummary: string[];
};

export type TransferLeg = {
  out: FplPlayer;
  incoming: FplPlayer;
  sellingPrice: number;
  buyingPrice: number;
};

export type RiskDriver = {
  code: string;
  label: string;
  detail: string;
};

/**
 * Net expected value of a transfer plan versus the HOLD/ROLL baseline (type-B).
 * Ranking key is riskAdjustedFiveGwNetVsHold.
 */
export type TransferNetEV = {
  legs: TransferLeg[];
  transferCount: number;
  hitCost: number;
  hitLabel: string;
  bankAfter: number;
  freeTransfersAfter: number;
  /** FT available before this move. */
  freeTransfersBefore: number;
  /** Transfers required this GW. */
  transfersRequired: number;
  /** Transfers paid by FT. */
  freeTransfersUsed: number;
  /** Next-GW squad gross EP after the move (before hit). */
  nextGwGross: number;
  /** HOLD path next-GW gross (for hit detail). */
  holdNextGwGross: number;
  /** Undiscounted squad EP deltas vs HOLD weekly (gross, before hit). */
  grossDelta1: number;
  grossDelta3: number;
  grossDelta5: number;
  /** Raw (pre risk-adj) discounted 5-GW NET vs type-B HOLD. */
  fiveGwNetVsHold: number;
  /** Discounted 3-GW NET vs type-B HOLD (full hit in week 1). */
  threeGwNetVsHold: number;
  /** Risk-adjusted fiveGwNetVsHold used for ranking / classification. */
  riskAdjustedFiveGwNetVsHold: number;
  /** @deprecated alias of fiveGwNetVsHold */
  netEv5: number;
  /** @deprecated alias of threeGwNetVsHold */
  netEv3: number;
  /** @deprecated alias of riskAdjustedFiveGwNetVsHold */
  riskAdjustedNet5: number;
  /** Risk multiplier applied when fiveGwNetVsHold > 0. */
  riskAdjustment: number;
  confidence: number;
  risk: "Low" | "Medium" | "High";
  riskDrivers: RiskDriver[];
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
  /** Act-now plan discounted total. */
  transferNowPlanTotal: number;
  /** Hold-now (type-B) plan discounted total. */
  holdNowPlanTotal: number;
  /** Act-now vs wait-one-GW-then-same-transfer (hits). null when waiting cannot help. */
  timingEvVsWait: number | null;
  /** Simplified future path after transferring now. */
  transferNowPath: string[];
  /** Simplified future path after holding now. */
  holdNowPath: string[];
  /** Structured path legs for UI drilldown. */
  transferNowPathLegs?: PlanPathLeg[];
  holdNowPathLegs?: PlanPathLeg[];
  /** riskAdjustedFiveGwNetVsHold − fiveGwNetVsHold (points delta from confidence-only adj). */
  riskAdjustmentPointsDelta?: number;
  /** Structured reason codes for multi-signal classification. */
  reasonCodes: string[];
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
  threeGwNetVsHold: number;
  fiveGwNetVsHold: number;
  riskAdjustedFiveGwNetVsHold: number;
  /** @deprecated */
  net3: number;
  /** @deprecated */
  net5: number;
  /** @deprecated */
  riskAdjustedNet5: number;
  confidence: number;
  risk: "Low" | "Medium" | "High";
  reason: string;
  riskDrivers?: RiskDriver[];
  transferNowPath?: string[];
  holdNowPath?: string[];
  timingEvVsWait?: number | null;
  freeTransfersBefore?: number;
  freeTransfersAfter?: number;
};

export type BestDecision = {
  action: "HOLD" | "MAKE";
  classification: TransferClassification;
  headline: string;
  reason: string;
  confidence: number;
  risk: "Low" | "Medium" | "High";
  hitLabel: string;
  hitCost: number;
  threeGwNetVsHold: number;
  fiveGwNetVsHold: number;
  riskAdjustedFiveGwNetVsHold: number;
  /** Best alternative move when primary is HOLD (often WATCH). */
  alternative: TransferRecommendation | null;
  recommendation: TransferRecommendation;
};

export type TransferEngineResult = {
  rules: TransferEngineRules;
  hold: HoldBaseline;
  /** Primary decision: HOLD or best MAKE/LEAN. */
  primary: TransferRecommendation | null;
  /** Hero answer: Should I transfer? */
  bestDecision: BestDecision | null;
  recommendations: TransferRecommendation[];
  /** Explicit ROLL/HOLD card always present for UI baseline. */
  rollCard: TransferRecommendationCard;
  holdPlan?: FuturePlan;
};

/** shallow = Overview/first-paint (no deep future beam). deep = Transfers/deferred. */
export type TransferPlanningMode = "shallow" | "deep";

export type TransferEngineOptions = {
  rules?: Partial<TransferEngineRules>;
  limit?: number;
  /** Max transfers in the week-1 action being scored (1 or 2). */
  maxTransfersWeek1?: 1 | 2;
  /** When true (default), insert an explicit HOLD row into ranked recommendations. */
  includeHold?: boolean;
  /**
   * Planning mode split for hang prevention.
   * - shallow: forces futureBeamWidth/beamWidth to 0 (Overview sync path).
   * - deep: full type-B budgets (Transfers / deferred upgrade).
   * When omitted, rules.futureBeamWidth decides (0 ⇒ shallow behaviour).
   */
  mode?: TransferPlanningMode;
};
