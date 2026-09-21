/**
 * Configurable FPL 2026/27 transfer rules for the recommendation engine.
 * Tunable — never hardcode season constants at call sites.
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
   * Default: 1.00, 0.94, 0.88, 0.82, 0.76
   */
  horizonDiscounts: readonly number[];
  /** Risk-adj 5-GW NET vs HOLD thresholds for classification. */
  makeNetThreshold: number;
  leanNetThreshold: number;
  /** Below this risk-adj NET → AVOID (when a move was evaluated). */
  avoidNetCeiling: number;
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
};

export const DEFAULT_TRANSFER_RULES_2026_27: TransferEngineRules = Object.freeze({
  hitPointsPerTransfer: 4,
  freeTransferCap: 5,
  freeTransfersGainedPerGw: 1,
  squadSize: 15,
  teamLimit: 3,
  horizonGw: 5,
  horizonDiscounts: Object.freeze([1.0, 0.94, 0.88, 0.82, 0.76]),
  makeNetThreshold: 2.5,
  leanNetThreshold: 1.0,
  avoidNetCeiling: -0.5,
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
});

export function mergeTransferRules(
  overrides: Partial<TransferEngineRules> = {},
): TransferEngineRules {
  const base = DEFAULT_TRANSFER_RULES_2026_27;
  const discounts = overrides.horizonDiscounts ?? base.horizonDiscounts;
  return {
    ...base,
    ...overrides,
    horizonDiscounts: Object.freeze([...discounts]),
  };
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
