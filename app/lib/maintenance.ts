/**
 * Scheduled housekeeping (cron -> worker/index.ts `scheduled`). Pure of Next/Cloudflare imports:
 * takes any D1-shaped handle so it unit-tests against node:sqlite (tests/maintenance.test.mts).
 *
 * 1. sessions: DELETE rows whose expires_at is in the past. getUserBySessionToken already rejects
 *    (and lazily deletes) an expired token when it is presented, but sessions nobody presents again
 *    were never removed and grew without bound.
 * 2. login_rate_limits: DELETE rows whose counting window has fully elapsed AND that are not
 *    currently blocked. Such a row is behaviourally identical to "no row" (the next attempt resets
 *    the window to 1 anyway), so pruning cannot weaken any limit. Rows cleared on successful login
 *    (window_started_at = epoch) are stale immediately. The window used is the LONGEST of any key
 *    namespace (signup: 1h; login: 15m), so a row is never pruned while any namespace still counts it.
 *
 * All timestamps are ISO-8601 UTC strings, which sort lexicographically == chronologically.
 */
import { RATE_LIMIT_MAX_WINDOW_MS } from "./login-rate-limit";

export type D1Like = {
  prepare(query: string): { bind(...values: unknown[]): { run(): Promise<{ meta?: { changes?: number } | Record<string, unknown> }> } };
};

export type PruneResult = { sessionsDeleted: number; rateLimitsDeleted: number };

function changes(result: { meta?: unknown }): number {
  const meta = result?.meta as { changes?: number } | undefined;
  return typeof meta?.changes === "number" ? meta.changes : 0;
}

export async function pruneExpiredData(db: D1Like, nowMs: number = Date.now()): Promise<PruneResult> {
  const nowIso = new Date(nowMs).toISOString();
  const staleWindowCutoff = new Date(nowMs - RATE_LIMIT_MAX_WINDOW_MS).toISOString();

  const sessions = await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(nowIso).run();
  // Independent statements: a missing login_rate_limits table (migration lag) must not stop session pruning,
  // and vice versa; the caller logs failures per step.
  let rateLimitsDeleted = 0;
  try {
    const limits = await db
      .prepare("DELETE FROM login_rate_limits WHERE window_started_at < ? AND (blocked_until IS NULL OR blocked_until < ?)")
      .bind(staleWindowCutoff, nowIso)
      .run();
    rateLimitsDeleted = changes(limits);
  } catch (error) {
    const message = error instanceof Error ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}` : "";
    if (!message.includes("no such table")) throw error;
  }
  return { sessionsDeleted: changes(sessions), rateLimitsDeleted };
}
