/**
 * Password sign-in rate limits: per-account (email) and per-IP.
 * Pure decision helpers are unit-testable; D1 storage is optional at the route.
 * No new Cloudflare secrets — uses the existing DB binding.
 */

export type RateLimitBucket = {
  key: string;
  kind: "email" | "ip";
  failCount: number;
  windowStartedAt: string;
  blockedUntil: string | null;
};

export type RateLimitDecision =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number; reason: "email" | "ip" };

export const LOGIN_RATE_LIMIT = {
  /** Failed attempts counted inside the sliding window. */
  maxFails: 5,
  /** Window length for counting failures (ms). */
  windowMs: 15 * 60 * 1000,
  /** Lockout duration after maxFails (ms). */
  blockMs: 15 * 60 * 1000,
} as const;

export function normalizeLoginEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function clientIpFromRequest(request: Request): string {
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf.slice(0, 64);
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded.slice(0, 64);
  return "unknown";
}

export function rateLimitKeys(email: string, ip: string): { emailKey: string; ipKey: string } {
  return {
    emailKey: `email:${normalizeLoginEmail(email)}`,
    ipKey: `ip:${ip || "unknown"}`,
  };
}

function parseIso(value: string | null | undefined): number {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

/** Decide whether this attempt may proceed given stored buckets. */
export function evaluateLoginRateLimit(
  buckets: Array<Pick<RateLimitBucket, "kind" | "failCount" | "windowStartedAt" | "blockedUntil">>,
  nowMs: number = Date.now(),
): RateLimitDecision {
  for (const bucket of buckets) {
    const blockedUntil = parseIso(bucket.blockedUntil);
    if (blockedUntil > nowMs) {
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - nowMs) / 1000)),
        reason: bucket.kind,
      };
    }
  }
  return { ok: true };
}

/**
 * After a failed password check, update a bucket's failCount / block.
 * Successful logins should clear buckets via clearLoginRateLimitBucket.
 */
export function registerLoginFailure(
  bucket: RateLimitBucket | null,
  key: string,
  kind: "email" | "ip",
  nowMs: number = Date.now(),
): RateLimitBucket {
  const windowMs = LOGIN_RATE_LIMIT.windowMs;
  const nowIso = new Date(nowMs).toISOString();
  if (!bucket) {
    return {
      key,
      kind,
      failCount: 1,
      windowStartedAt: nowIso,
      blockedUntil: null,
    };
  }
  const windowStart = parseIso(bucket.windowStartedAt);
  const inWindow = windowStart > 0 && nowMs - windowStart < windowMs;
  const failCount = inWindow ? bucket.failCount + 1 : 1;
  const blocked =
    failCount >= LOGIN_RATE_LIMIT.maxFails
      ? new Date(nowMs + LOGIN_RATE_LIMIT.blockMs).toISOString()
      : null;
  return {
    key,
    kind,
    failCount,
    windowStartedAt: inWindow ? bucket.windowStartedAt : nowIso,
    blockedUntil: blocked,
  };
}

/**
 * Mirrors incrementLoginFailureAtomic SQL CASE semantics (single-writer / serialized row update).
 * Concurrent same-key attempts must each apply this once; RMW "read 4 → write 5" races are what
 * the store's ON CONFLICT UPDATE avoids. Expected limits: maxFails within windowMs → blockedUntil
 * for blockMs; window expiry resets failCount to 1.
 */
export function applyAtomicLoginFailureIncrement(
  existing: Pick<RateLimitBucket, "failCount" | "windowStartedAt" | "blockedUntil"> | null,
  nowMs: number = Date.now(),
): Pick<RateLimitBucket, "failCount" | "windowStartedAt" | "blockedUntil"> {
  const nowIso = new Date(nowMs).toISOString();
  const windowStartCutoff = nowMs - LOGIN_RATE_LIMIT.windowMs;
  const inWindow =
    existing != null && Number.isFinite(Date.parse(existing.windowStartedAt))
      ? Date.parse(existing.windowStartedAt) >= windowStartCutoff
      : false;
  const failCount = inWindow && existing ? existing.failCount + 1 : 1;
  const windowStartedAt = inWindow && existing ? existing.windowStartedAt : nowIso;
  const blockedUntil =
    failCount >= LOGIN_RATE_LIMIT.maxFails
      ? new Date(nowMs + LOGIN_RATE_LIMIT.blockMs).toISOString()
      : null;
  return { failCount, windowStartedAt, blockedUntil };
}

export function clearLoginRateLimitBucket(
  key: string,
  kind: "email" | "ip",
): RateLimitBucket {
  return {
    key,
    kind,
    failCount: 0,
    windowStartedAt: new Date(0).toISOString(),
    blockedUntil: null,
  };
}

// --- Signup rate limit (per client IP) -------------------------------------------------------
// Signup runs a 100k-iteration PBKDF2 per request and used to have no limit at all. Every signup
// ATTEMPT (not just failures) counts. Same login_rate_limits table + same one-statement atomic
// upsert pattern as the login limiter, but a separate key namespace ("signup:ip:...") so signup
// traffic can never lock anyone out of sign-in and vice versa.

export const SIGNUP_RATE_LIMIT = {
  /** Signup attempts allowed per IP inside one window. Generous: mobile carriers NAT many users behind one IP. */
  maxAttempts: 10,
  /** Fixed window length (ms). Once maxAttempts is exceeded the caller is blocked until the window ends. */
  windowMs: 60 * 60 * 1000,
} as const;

export function signupIpKey(ip: string): string {
  return `signup:ip:${ip || "unknown"}`;
}

/**
 * Pure mirror of the SQL in consumeSignupAttemptAtomic (login-rate-limit-store.ts).
 * Returns the post-increment counters; `blocked` is true once the attempt count exceeds maxAttempts.
 */
export function applyAtomicSignupIncrement(
  existing: Pick<RateLimitBucket, "failCount" | "windowStartedAt"> | null,
  nowMs: number = Date.now(),
): { failCount: number; windowStartedAt: string } {
  const cutoff = nowMs - SIGNUP_RATE_LIMIT.windowMs;
  const inWindow = existing != null && Date.parse(existing.windowStartedAt) >= cutoff;
  return inWindow && existing
    ? { failCount: existing.failCount + 1, windowStartedAt: existing.windowStartedAt }
    : { failCount: 1, windowStartedAt: new Date(nowMs).toISOString() };
}

export function evaluateSignupAttempt(
  counters: { failCount: number; windowStartedAt: string },
  nowMs: number = Date.now(),
): RateLimitDecision {
  if (counters.failCount <= SIGNUP_RATE_LIMIT.maxAttempts) return { ok: true };
  const windowEnd = parseIso(counters.windowStartedAt) + SIGNUP_RATE_LIMIT.windowMs;
  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((windowEnd - nowMs) / 1000)), reason: "ip" };
}

/**
 * A row is stale (safe to delete) when its counting window has fully elapsed and it is not
 * currently blocked. Uses the longest window of any namespace, so it is valid for login + signup rows.
 * Rows cleared by clearLoginFailures (window_started_at = epoch) are stale immediately.
 */
export const RATE_LIMIT_MAX_WINDOW_MS = Math.max(LOGIN_RATE_LIMIT.windowMs, SIGNUP_RATE_LIMIT.windowMs);
