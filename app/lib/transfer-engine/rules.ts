/**
 * Configurable FPL 2026/27 transfer rules for the recommendation engine.
 * Tunable — never hardcode season constants at call sites.
 * BALANCED defaults below; FREE vs -4 HIT thresholds are separate.
 */

export type TransferEngineRules = {
  /** Points deducted per transfer beyond free transfers. Official: 4. */
  hitPointsPerTransfer: number;
  /** Max banked free transfers. Official: 5. */
  freeTransferCap: number;
  /** Free transfers awarded after each deadline (when under cap). Official: 1. */
  freeTransfersGainedPerGw: number;
  /** Squad size. Official: 15. */
  squadSize: number;
  /** Max players from one club. Official: 3. */
  teamLimit: number;
  /** Planning horizon in gameweeks for primary ranking. */
  horizonGw: number;
  /**
   * Per-GW discount factors applied to squad EP (index 0 = next GW).
   * Default: 1.00, 0.94, 0.88, 0.82, 0.76 — DO NOT change projection weights here.
   */
  horizonDiscounts: readonly number[];

  // --- FREE transfer classification thresholds (risk-adj 5-GW NET vs HOLD) ---
  /** FREE: MAKE when risk-adj NET >= this. BALANCED default +2.0 */
  freeMakeNetThreshold: number;
  /** FREE: LEAN floor (below MAKE). BALANCED default +0.75 */
  freeLeanNetThreshold: number;
  /** FREE: WATCH floor (below LEAN). BALANCED default +0.25 */
  freeWatchNetThreshold: number;
  /** FREE: HOLD band half-width around 0. BALANCED default 0.25 → HOLD in [-0.25, +0.25] */
  freeHoldBand: number;
  /** FREE: below this → AVOID. BALANCED default -0.25 */
  freeAvoidNetCeiling: number;

  // --- HIT (-4 / paid) classification thresholds ---
  /** HIT: MAKE when risk-adj NET >= this. BALANCED default +4.0 */
  hitMakeNetThreshold: number;
  /** HIT: LEAN floor. BALANCED default +3.0 */
  hitLeanNetThreshold: number;
  /** HIT: WATCH floor. BALANCED default +0.5 */
  hitWatchNetThreshold: number;
  /** HIT: HOLD band half-width. BALANCED default 0.25 */
  hitHoldBand: number;
  /** HIT: below this → AVOID. BALANCED default 0 (clearly negative) */
  hitAvoidNetCeiling: number;

  /**
   * Decision margin: risk-adj NET must clear the MAKE threshold by at least this
   * extra amount on FREE moves so tiny positives do not become MAKE.
   */
  freeMakeMargin: number;
  /** Extra margin required on top of hitMakeNetThreshold for MAKE on hits. */
  hitMakeMargin: number;

  /**
   * When a hit move has shortTermNet (3-GW) < 0 and 5-GW risk-adj is only modest
   * (below this), classify WATCH instead of LEAN unless long-term is very strong.
   */
  hitModestLongTermCeiling: number;
  /** Long-term risk-adj NET that overrides the short-term-negative → WATCH rule. */
  hitStrongLongTermFloor: number;

  /** Minimum incoming start probability for MAKE (role security). */
  makeStartProbability: number;
  /** Minimum incoming expected minutes for MAKE. */
  makeExpectedMinutes: number;
  /** Minimum incoming projection confidence for MAKE. */
  makeConfidence: number;
  /** Watchlist floors (softer than MAKE). */
  watchStartProbability: number;
  watchExpectedMinutes: number;
  watchConfidence: number;
  /** Beam width for multi-GW search. */
  beamWidth: number;
  /** Max candidate ins per position when scanning. */
  candidatePoolPerPosition: number;
  /** Max single-move recommendations returned. */
  resultLimit: number;
  /** Max hit points allowed in week-1 evaluation (0 / 4 / 8). */
  maxWeek1Hit: number;
  /** Cap how many top results share the same outgoing player (family diversity). */
  maxSameOutgoingInResults: number;
  /** Cap how many top results share the same incoming player. */
  maxSameIncomingInResults: number;
  /** Minimum remaining-horizon gain to take a future free transfer in type-B plans. */
  futureTransferMargin: number;

  // --- Legacy aliases (kept for older callers / JSON) ---
  /** @deprecated use freeMakeNetThreshold */
  makeNetThreshold: number;
  /** @deprecated use freeLeanNetThreshold */
  leanNetThreshold: number;
  /** @deprecated use freeAvoidNetCeiling */
  avoidNetCeiling: number;
};

export const DEFAULT_TRANSFER_RULES_2026_27: TransferEngineRules = Object.freeze({
  hitPointsPerTransfer: 4,
  freeTransferCap: 5,
  freeTransfersGainedPerGw: 1,
  squadSize: 15,
  teamLimit: 3,
  horizonGw: 5,
  horizonDiscounts: Object.freeze([1.0, 0.94, 0.88, 0.82, 0.76]),

  freeMakeNetThreshold: 2.0,
  freeLeanNetThreshold: 0.75,
  freeWatchNetThreshold: 0.25,
  freeHoldBand: 0.25,
  freeAvoidNetCeiling: -0.25,

  hitMakeNetThreshold: 4.0,
  hitLeanNetThreshold: 3.0,
  hitWatchNetThreshold: 0.5,
  hitHoldBand: 0.25,
  hitAvoidNetCeiling: 0,

  freeMakeMargin: 0.15,
  hitMakeMargin: 0.35,

  hitModestLongTermCeiling: 2.5,
  hitStrongLongTermFloor: 5.0,

  makeStartProbability: 0.7,
  makeExpectedMinutes: 60,
  makeConfidence: 0.55,
  watchStartProbability: 0.55,
  watchExpectedMinutes: 45,
  watchConfidence: 0.35,
  beamWidth: 36,
  candidatePoolPerPosition: 18,
  resultLimit: 24,
  maxWeek1Hit: 8,
  maxSameOutgoingInResults: 2,
  maxSameIncomingInResults: 2,
  futureTransferMargin: 0.35,

  // Legacy mirrors of FREE thresholds
  makeNetThreshold: 2.0,
  leanNetThreshold: 0.75,
  avoidNetCeiling: -0.25,
});

export function mergeTransferRules(
  overrides: Partial<TransferEngineRules> = {},
): TransferEngineRules {
  const base = DEFAULT_TRANSFER_RULES_2026_27;
  const discounts = overrides.horizonDiscounts ?? base.horizonDiscounts;
  const merged = {
    ...base,
    ...overrides,
    horizonDiscounts: Object.freeze([...discounts]) as readonly number[],
  };
  // Keep legacy aliases in sync when only the new keys are overridden.
  if (overrides.freeMakeNetThreshold !== undefined && overrides.makeNetThreshold === undefined) {
    merged.makeNetThreshold = overrides.freeMakeNetThreshold;
  }
  if (overrides.freeLeanNetThreshold !== undefined && overrides.leanNetThreshold === undefined) {
    merged.leanNetThreshold = overrides.freeLeanNetThreshold;
  }
  if (overrides.freeAvoidNetCeiling !== undefined && overrides.avoidNetCeiling === undefined) {
    merged.avoidNetCeiling = overrides.freeAvoidNetCeiling;
  }
  return merged;
}

/** Official hit formula: max(0, n − FT) × hitPoints. */
export function exactHitCost(
  transferCount: number,
  freeTransfers: number,
  rules: TransferEngineRules = DEFAULT_TRANSFER_RULES_2026_27,
): number {
  const n = Math.max(0, Math.floor(transferCount));
  const ft = clampFreeTransfers(freeTransfers, rules);
  return Math.max(0, n - ft) * rules.hitPointsPerTransfer;
}

export function clampFreeTransfers(
  freeTransfers: number,
  rules: TransferEngineRules = DEFAULT_TRANSFER_RULES_2026_27,
): number {
  if (!Number.isFinite(freeTransfers)) return 0;
  return Math.max(0, Math.min(rules.freeTransferCap, Math.floor(freeTransfers)));
}

/** After a deadline: spend transfers, then gain one FT (capped). */
export function freeTransfersAfterDeadline(
  freeTransfersBefore: number,
  transfersMade: number,
  rules: TransferEngineRules = DEFAULT_TRANSFER_RULES_2026_27,
): number {
  const before = clampFreeTransfers(freeTransfersBefore, rules);
  const spent = Math.max(0, Math.floor(transfersMade));
  return Math.min(
    rules.freeTransferCap,
    Math.max(0, before - spent) + rules.freeTransfersGainedPerGw,
  );
}

export function hitLabel(
  hitCost: number,
  rules: TransferEngineRules = DEFAULT_TRANSFER_RULES_2026_27,
): "Free" | "-4" | "-8" | string {
  if (hitCost <= 0) return "Free";
  if (hitCost === rules.hitPointsPerTransfer) return "-4";
  if (hitCost === rules.hitPointsPerTransfer * 2) return "-8";
  return `−${hitCost}`;
}

/** Active threshold set for a move given whether a hit is paid. */
export function thresholdsForHit(hitCost: number, rules: TransferEngineRules) {
  const isHit = hitCost > 0;
  return {
    isHit,
    make: isHit ? rules.hitMakeNetThreshold : rules.freeMakeNetThreshold,
    lean: isHit ? rules.hitLeanNetThreshold : rules.freeLeanNetThreshold,
    watch: isHit ? rules.hitWatchNetThreshold : rules.freeWatchNetThreshold,
    holdBand: isHit ? rules.hitHoldBand : rules.freeHoldBand,
    avoid: isHit ? rules.hitAvoidNetCeiling : rules.freeAvoidNetCeiling,
    makeMargin: isHit ? rules.hitMakeMargin : rules.freeMakeMargin,
  };
}
