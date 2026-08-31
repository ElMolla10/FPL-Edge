import { PlayerCalibrationGroup, ROLE_SECURITY_FLOOR } from "./fpl";

// Moved from CoachApp.tsx so LiveDraftBuilder.tsx's recommended-changes section can reuse the same
// per-player quality gate and action threshold bestTransfers()/selectPrimaryTransfer() already use,
// without a circular import (CoachApp.tsx already imports LiveDraftBuilder, so LiveDraftBuilder
// importing anything back from CoachApp.tsx would cycle). sortTransfersByQuality/selectPrimaryTransfer
// themselves stay in CoachApp.tsx -- they operate on the Transfer type, which is Transfers-page-
// specific and has no reason to live in a neutral lib file. TRANSFER_ACTION_THRESHOLD is the one
// piece of selectPrimaryTransfer Draft Lab actually needs: the same 2.2-point bar, applied directly
// to a squad-level net-of-hit-cost figure instead of a single Transfer row's rankScore.
export const TRANSFER_ACTION_THRESHOLD = 2.2;
export const OFFICIAL_TRANSFER_HIT = 4;

export function transferHitCost(transferCount: number, freeTransfers: number): number {
  return Math.max(0, transferCount - freeTransfers) * OFFICIAL_TRANSFER_HIT;
}

export type TransferQualityStatus = "actionable" | "watchlist" | "blocked";
export type TransferQualityReason = { code: string; message: string };
export type TransferQualityInput = {
  gain1: number; gain3: number; gain5: number; weeklyGains: number[];
  expectedMinutes: number; startProbability: number; confidence: number;
  calibrationGroup: PlayerCalibrationGroup; lowPlContinuityClub: boolean;
  anomalyCodes: string[];
};
export type TransferQuality = {
  status: TransferQualityStatus; score: number; reasons: TransferQualityReason[];
  positiveWeeks: number; gainWithoutBestWeek: number;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

// A projection can be numerically attractive without being credible enough to act on. This pure
// gate makes that distinction before ranking, rather than attaching warnings after a row is #1.
export function evaluateTransferQuality(input: TransferQualityInput): TransferQuality {
  const positiveWeeks = input.weeklyGains.filter((gain) => gain > 0.05).length;
  const bestWeek = input.weeklyGains.length ? Math.max(...input.weeklyGains) : 0;
  const gainWithoutBestWeek = input.gain5 - bestWeek;
  const evidence = input.calibrationGroup === "established-pl" ? 1 : input.calibrationGroup === "current-pl-established" ? 0.9 : input.calibrationGroup === "limited-pl" ? 0.55 : 0.35;
  const continuity = input.lowPlContinuityClub ? 0.8 : 1;
  const robustness = 0.65 * (positiveWeeks / Math.max(1, input.weeklyGains.length)) + 0.35 * clamp01((gainWithoutBestWeek + 1) / 3);
  const rawScore = Math.round(100 * (0.30 * clamp01(input.startProbability) + 0.25 * clamp01(input.confidence) + 0.20 * clamp01(input.expectedMinutes / 90) + 0.15 * robustness + 0.10 * evidence * continuity));
  const reasons: TransferQualityReason[] = [];
  const hard = (code: string, message: string) => reasons.push({ code, message });
  const watch = (code: string, message: string) => reasons.push({ code, message });
  const severe = new Set(["five-gw-gain-anomaly", "low-certainty-elite-projection", "high-risk-top-recommendation"]);
  const severeFlags = input.anomalyCodes.filter((code) => severe.has(code));
  if (severeFlags.length) hard("projection-plausibility", `Projection failed ${severeFlags.length} hard plausibility check${severeFlags.length === 1 ? "" : "s"}: ${severeFlags.join(", ")}.`);
  if (input.startProbability < ROLE_SECURITY_FLOOR.startProbability) hard("insufficient-start-probability", `Only ${Math.round(input.startProbability * 100)}% start probability; this cannot be an actionable transfer.`);
  if (input.expectedMinutes < ROLE_SECURITY_FLOOR.expectedMinutes) hard("insufficient-expected-minutes", `Only ${Math.round(input.expectedMinutes)} expected minutes; role security is below the action floor.`);
  if (input.confidence < ROLE_SECURITY_FLOOR.confidence) hard("insufficient-model-confidence", `Projection evidence is only ${Math.round(input.confidence * 100)}%, below the hard safety floor.`);
  const hasHard = reasons.length > 0;
  if (!hasHard) {
    if (input.startProbability < 0.70) watch("start-probability-watch", `${Math.round(input.startProbability * 100)}% start probability needs confirmation before acting.`);
    if (input.expectedMinutes < 60) watch("minutes-watch", `${Math.round(input.expectedMinutes)} expected minutes makes the route too role-sensitive for the primary recommendation.`);
    if (input.confidence < 0.60) watch("confidence-watch", `${Math.round(input.confidence * 100)}% projection evidence is below the actionable threshold.`);
    if (input.calibrationGroup === "no-pl-prior") watch("no-pl-evidence", `No genuine prior-season Premier League evidence; wait for a stable top-flight sample.`);
    if (input.calibrationGroup === "limited-pl") watch("limited-pl-evidence", `Limited prior-season Premier League evidence; recommendation remains provisional.`);
    if (input.lowPlContinuityClub) watch("low-club-continuity", `The incoming player's club has limited roster-level Premier League continuity.`);
    if (input.gain5 <= 0) watch("no-projected-gain", `The route does not improve the optimized squad across the five-gameweek horizon.`);
    if (positiveWeeks < 2 || gainWithoutBestWeek <= 0) watch("single-week-dependence", `The five-gameweek gain does not remain positive after removing its single best gameweek.`);
    if (input.gain5 > 0 && input.gain3 <= 0) watch("timing-not-ready", `The route is positive over five gameweeks but not over the next three; monitor rather than move now.`);
  }
  const status: TransferQualityStatus = hasHard ? "blocked" : reasons.length ? "watchlist" : "actionable";
  const score = status === "blocked" ? Math.min(rawScore, 39) : status === "watchlist" ? Math.min(rawScore, 69) : rawScore;
  return { status, score, reasons, positiveWeeks, gainWithoutBestWeek };
}
