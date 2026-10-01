/**
 * Account notification preferences (D1 table notification_prefs, migration 0011).
 * Raw-SQL / D1-shaped on purpose so the same code unit-tests against node:sqlite.
 *
 * Default is OFF: no row == not opted in. Nothing here ever reads or stores FPL credentials.
 */
import { BodyError, isPlainObject } from "./request-guards";

export type PrefsDb = {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
    };
  };
};

export type NotificationPrefs = { notifyCallChanges: boolean; hasConnectedTeam: boolean };

/** Hand-rolled validator (same style as parseSquadBody): exactly one boolean field, nothing else. */
export function parseNotificationPrefsBody(body: unknown): { notifyCallChanges: boolean } {
  if (!isPlainObject(body)) throw new BodyError("Request body must be a JSON object.");
  for (const key of Object.keys(body)) {
    if (key !== "notifyCallChanges") throw new BodyError(`Unknown field "${key}".`);
  }
  if (typeof body.notifyCallChanges !== "boolean") throw new BodyError('"notifyCallChanges" must be true or false.');
  return { notifyCallChanges: body.notifyCallChanges };
}

export async function readNotificationPrefs(db: PrefsDb, userId: string): Promise<NotificationPrefs> {
  const row = await db
    .prepare(
      `SELECT COALESCE((SELECT notify_call_changes FROM notification_prefs WHERE user_id = ?), 0) AS on_flag,
              COALESCE((SELECT 1 FROM squad_data WHERE user_id = ? AND entry IS NOT NULL AND entry <> ''), 0) AS connected`,
    )
    .bind(userId, userId)
    .first<{ on_flag: number; connected: number }>();
  return { notifyCallChanges: Number(row?.on_flag) === 1, hasConnectedTeam: Number(row?.connected) === 1 };
}

/**
 * Persist the opt-in. Turning it OFF forgets the last call (hash, ids, flag fingerprint, last-checked) so a later
 * opt-in starts clean, but KEEPS the per-day sent counters so off/on cannot be used to dodge the daily cap.
 */
export async function writeNotifyOptIn(db: PrefsDb, userId: string, enabled: boolean, nowIso: string): Promise<void> {
  const flag = enabled ? 1 : 0;
  await db
    .prepare(
      `INSERT INTO notification_prefs (user_id, notify_call_changes, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         notify_call_changes = ?,
         last_call_hash = CASE WHEN ? = 1 THEN notification_prefs.last_call_hash ELSE NULL END,
         last_call_json = CASE WHEN ? = 1 THEN notification_prefs.last_call_json ELSE NULL END,
         last_flag_fingerprint = CASE WHEN ? = 1 THEN notification_prefs.last_flag_fingerprint ELSE NULL END,
         last_checked_at = CASE WHEN ? = 1 THEN notification_prefs.last_checked_at ELSE NULL END,
         updated_at = ?`,
    )
    .bind(userId, flag, nowIso, flag, flag, flag, flag, flag, nowIso)
    .run();
}

/** Toggle writes per user per hour (reuses the atomic login_rate_limits counter, namespace "notify:user:"). */
export const notifyWriteKey = (userId: string) => `notify:user:${userId}`;
