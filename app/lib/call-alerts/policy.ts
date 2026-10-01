/**
 * When may we email? Pure, so the cap is unit-tested without a database.
 *
 *   - hash unchanged since the last email we SENT            -> skip (nothing new)
 *   - at most ONE email per user per UTC calendar day
 *   - ... except a SECOND (hard cap: 2) when an official FPL flag APPEARED, i.e. the current flag fingerprint
 *     contains a token that the last emailed fingerprint did not (a newly flagged player, or a worse chance)
 *
 * A skipped (capped) call is NOT recorded: the stored hash stays at the last emailed call, so tomorrow's run
 * still sees "changed" and sends the then-current call.
 */
export const MAX_EMAILS_PER_UTC_DAY = 1;
export const MAX_EMAILS_PER_UTC_DAY_WITH_NEW_FLAG = 2;

export type StoredAlertState = {
  lastCallHash: string | null;
  emailsSentUtcDate: string | null;
  emailsSentToday: number;
  /** Canonical "token|token" string of the flags at the last send; null when never sent (or after opt-out). */
  lastFlagFingerprint: string | null;
};

export type SendDecision =
  | { send: false; reason: "unchanged" | "daily-cap" }
  | { send: true; newFlag: boolean; sentToday: number; today: string };

export function utcDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function fingerprintTokens(fingerprint: string | null | undefined): string[] {
  return fingerprint ? fingerprint.split("|").filter(Boolean) : [];
}

export function decideSend(state: StoredAlertState, currentHash: string, currentFlags: readonly string[], nowMs: number): SendDecision {
  if (state.lastCallHash === currentHash) return { send: false, reason: "unchanged" };
  const today = utcDate(nowMs);
  const sentToday = state.emailsSentUtcDate === today ? Math.max(0, state.emailsSentToday) : 0;
  // A flag "appears" only relative to a fingerprint we actually emailed. No stored fingerprint (first ever email,
  // or just re-enabled) is never an exception: that email is governed by the plain daily cap.
  const previous = state.lastFlagFingerprint === null ? null : new Set(fingerprintTokens(state.lastFlagFingerprint));
  const newFlag = previous !== null && currentFlags.some((token) => !previous.has(token));
  const allowed = sentToday < MAX_EMAILS_PER_UTC_DAY || (newFlag && sentToday < MAX_EMAILS_PER_UTC_DAY_WITH_NEW_FLAG);
  return allowed ? { send: true, newFlag, sentToday, today } : { send: false, reason: "daily-cap" };
}
