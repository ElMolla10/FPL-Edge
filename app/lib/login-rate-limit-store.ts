import { eq, sql } from "drizzle-orm";
import { getDb, isMissingTableError } from "../../db";
import { loginRateLimits } from "../../db/schema";
import {
  LOGIN_RATE_LIMIT,
  RateLimitBucket,
  SIGNUP_RATE_LIMIT,
  evaluateSignupAttempt,
  signupIpKey,
  clearLoginRateLimitBucket,
  evaluateLoginRateLimit,
  rateLimitKeys,
  type RateLimitDecision,
} from "./login-rate-limit";

async function readBucket(key: string): Promise<RateLimitBucket | null> {
  try {
    const db = await getDb();
    const [row] = await db.select().from(loginRateLimits).where(eq(loginRateLimits.key, key)).limit(1);
    if (!row) return null;
    return {
      key: row.key,
      kind: row.kind as "email" | "ip",
      failCount: row.failCount,
      windowStartedAt: row.windowStartedAt,
      blockedUntil: row.blockedUntil,
    };
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }
}

async function writeBucket(bucket: RateLimitBucket): Promise<void> {
  try {
    const db = await getDb();
    await db
      .insert(loginRateLimits)
      .values({
        key: bucket.key,
        kind: bucket.kind,
        failCount: bucket.failCount,
        windowStartedAt: bucket.windowStartedAt,
        blockedUntil: bucket.blockedUntil,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: loginRateLimits.key,
        set: {
          kind: bucket.kind,
          failCount: bucket.failCount,
          windowStartedAt: bucket.windowStartedAt,
          blockedUntil: bucket.blockedUntil,
          updatedAt: new Date().toISOString(),
        },
      });
  } catch (error) {
    if (isMissingTableError(error)) return;
    throw error;
  }
}

/**
 * Atomic failed-attempt increment (single SQL statement).
 * Avoids read-modify-write races where concurrent failures could all read failCount=4 and never lock.
 * Window reset + block-at-maxFails are expressed in SQL so concurrent writers serialize on the row.
 * Expected limits (see LOGIN_RATE_LIMIT): maxFails inside windowMs → blockedUntil for blockMs;
 * same email/IP concurrent attempts must not double-count past the threshold or skip the lock.
 * Pure mirror for tests: applyAtomicLoginFailureIncrement in login-rate-limit.ts.
 */
export async function incrementLoginFailureAtomic(
  key: string,
  kind: "email" | "ip",
  nowMs: number = Date.now(),
): Promise<void> {
  const nowIso = new Date(nowMs).toISOString();
  const windowStartCutoff = new Date(nowMs - LOGIN_RATE_LIMIT.windowMs).toISOString();
  const blockUntil = new Date(nowMs + LOGIN_RATE_LIMIT.blockMs).toISOString();
  const maxFails = LOGIN_RATE_LIMIT.maxFails;
  try {
    const db = await getDb();
    // SQLite evaluates SET expressions using pre-update column values; nest the same
    // fail_count CASE inside blocked_until so the threshold sees the post-increment count.
    await db.run(sql`
      INSERT INTO login_rate_limits (key, kind, fail_count, window_started_at, blocked_until, updated_at)
      VALUES (${key}, ${kind}, 1, ${nowIso}, ${maxFails <= 1 ? blockUntil : null}, ${nowIso})
      ON CONFLICT(key) DO UPDATE SET
        kind = ${kind},
        fail_count = CASE
          WHEN login_rate_limits.window_started_at >= ${windowStartCutoff}
          THEN login_rate_limits.fail_count + 1
          ELSE 1
        END,
        window_started_at = CASE
          WHEN login_rate_limits.window_started_at >= ${windowStartCutoff}
          THEN login_rate_limits.window_started_at
          ELSE ${nowIso}
        END,
        blocked_until = CASE
          WHEN (
            CASE
              WHEN login_rate_limits.window_started_at >= ${windowStartCutoff}
              THEN login_rate_limits.fail_count + 1
              ELSE 1
            END
          ) >= ${maxFails}
          THEN ${blockUntil}
          ELSE NULL
        END,
        updated_at = ${nowIso}
    `);
  } catch (error) {
    if (isMissingTableError(error)) return;
    throw error;
  }
}

export async function assertLoginAllowed(email: string, ip: string): Promise<RateLimitDecision> {
  const { emailKey, ipKey } = rateLimitKeys(email, ip);
  const [emailBucket, ipBucket] = await Promise.all([readBucket(emailKey), readBucket(ipKey)]);
  return evaluateLoginRateLimit(
    [
      ...(emailBucket ? [{ ...emailBucket, kind: "email" as const }] : []),
      ...(ipBucket ? [{ ...ipBucket, kind: "ip" as const }] : []),
    ],
  );
}

export async function recordLoginFailure(email: string, ip: string): Promise<void> {
  const { emailKey, ipKey } = rateLimitKeys(email, ip);
  await Promise.all([
    incrementLoginFailureAtomic(emailKey, "email"),
    incrementLoginFailureAtomic(ipKey, "ip"),
  ]);
}

export async function clearLoginFailures(email: string, ip: string): Promise<void> {
  const { emailKey, ipKey } = rateLimitKeys(email, ip);
  await Promise.all([
    writeBucket(clearLoginRateLimitBucket(emailKey, "email")),
    writeBucket(clearLoginRateLimitBucket(ipKey, "ip")),
  ]);
}

/** Minimal executor so the SQL below can run against real SQLite in tests (drizzle d1 db in production). */
export type RateLimitSqlExecutor = { all(query: ReturnType<typeof sql>): Promise<unknown[]> | unknown[] };

/**
 * Count one signup attempt for `key` and return the post-increment counters, in ONE statement
 * (INSERT ... ON CONFLICT DO UPDATE ... RETURNING). Concurrent requests serialise on the row, so N
 * parallel attempts always yield counts 1..N: none can slip under the limit by reading a stale count.
 * Fixed window: the count resets to 1 once window_started_at is older than windowMs.
 * blocked_until is set to the window end once the limit is exceeded (informational + keeps the
 * prune query's "not currently blocked" rule meaningful); the decision uses the returned counters.
 * Pure mirror for tests: applyAtomicSignupIncrement in login-rate-limit.ts.
 */
export async function consumeSignupAttemptAtomicWith(
  db: RateLimitSqlExecutor,
  key: string,
  nowMs: number = Date.now(),
): Promise<RateLimitDecision> {
  const nowIso = new Date(nowMs).toISOString();
  const { windowMs, maxAttempts } = SIGNUP_RATE_LIMIT;
  const cutoff = new Date(nowMs - windowMs).toISOString();
  const rows = (await db.all(sql`
    INSERT INTO login_rate_limits (key, kind, fail_count, window_started_at, blocked_until, updated_at)
    VALUES (${key}, 'ip', 1, ${nowIso}, NULL, ${nowIso})
    ON CONFLICT(key) DO UPDATE SET
      kind = 'ip',
      fail_count = CASE
        WHEN login_rate_limits.window_started_at >= ${cutoff}
        THEN login_rate_limits.fail_count + 1
        ELSE 1
      END,
      window_started_at = CASE
        WHEN login_rate_limits.window_started_at >= ${cutoff}
        THEN login_rate_limits.window_started_at
        ELSE ${nowIso}
      END,
      blocked_until = CASE
        WHEN (
          CASE
            WHEN login_rate_limits.window_started_at >= ${cutoff}
            THEN login_rate_limits.fail_count + 1
            ELSE 1
          END
        ) > ${maxAttempts}
        THEN strftime('%Y-%m-%dT%H:%M:%fZ', (
          CASE
            WHEN login_rate_limits.window_started_at >= ${cutoff}
            THEN login_rate_limits.window_started_at
            ELSE ${nowIso}
          END
        ), '+${sql.raw(String(Math.floor(windowMs / 1000)))} seconds')
        ELSE NULL
      END,
      updated_at = ${nowIso}
    RETURNING fail_count, window_started_at
  `)) as Array<Record<string, unknown> | unknown[]>;
  const row = rows[0];
  if (!row) return { ok: true };
  const failCount = Number(Array.isArray(row) ? row[0] : (row as Record<string, unknown>).fail_count);
  const windowStartedAt = String(Array.isArray(row) ? row[1] : (row as Record<string, unknown>).window_started_at);
  return evaluateSignupAttempt({ failCount, windowStartedAt }, nowMs);
}

/** Route entry point. Fails OPEN if the table is missing (same as the login limiter): migration lag must not take signup down. */
export async function consumeSignupAttempt(ip: string): Promise<RateLimitDecision> {
  try {
    const db = await getDb();
    return await consumeSignupAttemptAtomicWith(db as unknown as RateLimitSqlExecutor, signupIpKey(ip));
  } catch (error) {
    if (isMissingTableError(error)) return { ok: true };
    throw error;
  }
}
