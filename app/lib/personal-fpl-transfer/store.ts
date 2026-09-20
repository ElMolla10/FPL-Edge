import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { personalFplAuth } from "../../../db/schema";
import {
  extractRefreshToken,
  PERSONAL_FPL_REFRESH_TOKEN_ENV,
  type PersonalTransferEnv,
} from "./config";

const ROW_ID = "default";
const DEFAULT_LEASE_MS = 20_000;

export type PersonalAuthSession = {
  refreshToken: string;
  accessToken: string | null;
  /** Epoch milliseconds when the access token should be treated as expired. */
  accessExpiresAtMs: number | null;
};

// Never log the token. D1 holds the rotating refresh token because PingOne
// issues a new one on every exchange and Workers secrets cannot be rewritten
// from the worker. Access tokens are cached here so concurrent /api/fpl/team
// reads do not race-rotate the refresh token into invalid_grant.
// refresh_lease_until provides cross-isolate single-flight before hitting PingOne:
// concurrent refresh_token reuse triggers family revocation (invalid_grant).

function rowToSession(row: {
  refreshToken: string;
  accessToken?: string | null;
  accessExpiresAt?: string | null;
}): PersonalAuthSession {
  const expiresRaw = row.accessExpiresAt?.trim() ?? "";
  const expiresMs = /^\d+$/.test(expiresRaw) ? Number(expiresRaw) : null;
  return {
    refreshToken: row.refreshToken,
    accessToken: row.accessToken?.trim() ? row.accessToken : null,
    accessExpiresAtMs: expiresMs !== null && Number.isFinite(expiresMs) ? expiresMs : null,
  };
}

export async function loadPersonalAuthSession(env: PersonalTransferEnv): Promise<PersonalAuthSession | null> {
  const db = await getDb();
  const [row] = await db.select().from(personalFplAuth).where(eq(personalFplAuth.id, ROW_ID)).limit(1);
  if (row?.refreshToken) return rowToSession(row);

  const seeded = env[PERSONAL_FPL_REFRESH_TOKEN_ENV];
  if (!seeded?.trim()) return null;
  // extractRefreshToken rejects truncated oidc.user JSON (Worker secret 5 KB cap).
  const token = extractRefreshToken(seeded);
  if (!token) return null;
  await persistPersonalAuthSession({ refreshToken: token, accessToken: null, accessExpiresAtMs: null });
  return { refreshToken: token, accessToken: null, accessExpiresAtMs: null };
}

/** @deprecated Prefer loadPersonalAuthSession — kept for transfer execute path. */
export async function loadPersonalRefreshToken(env: PersonalTransferEnv): Promise<string | null> {
  const session = await loadPersonalAuthSession(env);
  return session?.refreshToken ?? null;
}

export async function persistPersonalRefreshToken(token: string): Promise<void> {
  const existing = await reloadPersonalAuthSessionFromDb();
  await persistPersonalAuthSession({
    refreshToken: token,
    accessToken: existing?.accessToken ?? null,
    accessExpiresAtMs: existing?.accessExpiresAtMs ?? null,
  });
}

export async function persistPersonalAuthSession(session: PersonalAuthSession): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const accessExpiresAt =
    session.accessExpiresAtMs !== null && Number.isFinite(session.accessExpiresAtMs)
      ? String(Math.trunc(session.accessExpiresAtMs))
      : null;
  const [existing] = await db.select().from(personalFplAuth).where(eq(personalFplAuth.id, ROW_ID)).limit(1);
  if (existing) {
    await db
      .update(personalFplAuth)
      .set({
        refreshToken: session.refreshToken,
        accessToken: session.accessToken,
        accessExpiresAt,
        refreshLeaseUntil: null,
        updatedAt: now,
      })
      .where(eq(personalFplAuth.id, ROW_ID));
    return;
  }
  await db.insert(personalFplAuth).values({
    id: ROW_ID,
    refreshToken: session.refreshToken,
    accessToken: session.accessToken,
    accessExpiresAt,
    refreshLeaseUntil: null,
    updatedAt: now,
  });
}

/**
 * Compare-and-swap refresh token update. Returns false when another isolate
 * already rotated away from `expectedRefreshToken` — caller should reload.
 * Clears refresh lease on success.
 */
export async function casPersistPersonalAuthSession(
  expectedRefreshToken: string,
  session: PersonalAuthSession,
): Promise<boolean> {
  const db = await getDb();
  const now = new Date().toISOString();
  const accessExpiresAt =
    session.accessExpiresAtMs !== null && Number.isFinite(session.accessExpiresAtMs)
      ? String(Math.trunc(session.accessExpiresAtMs))
      : null;
  const updated = await db
    .update(personalFplAuth)
    .set({
      refreshToken: session.refreshToken,
      accessToken: session.accessToken,
      accessExpiresAt,
      refreshLeaseUntil: null,
      updatedAt: now,
    })
    .where(and(eq(personalFplAuth.id, ROW_ID), eq(personalFplAuth.refreshToken, expectedRefreshToken)))
    .returning({ id: personalFplAuth.id });
  if (Array.isArray(updated) && updated.length > 0) return true;
  // Some drizzle/D1 drivers omit returning — fall back to read-back check.
  const current = await reloadPersonalAuthSessionFromDb();
  return Boolean(current && current.refreshToken === session.refreshToken);
}

/** Re-read session from D1 only (no env seed). Used after concurrent rotation. */
export async function reloadPersonalAuthSessionFromDb(): Promise<PersonalAuthSession | null> {
  const db = await getDb();
  const [row] = await db.select().from(personalFplAuth).where(eq(personalFplAuth.id, ROW_ID)).limit(1);
  if (!row?.refreshToken) return null;
  return rowToSession(row);
}

/**
 * Claim a short refresh lease so only one isolate calls PingOne for this token.
 * Returns false when another isolate holds a non-expired lease or the token rotated.
 */
export async function claimRefreshLease(
  expectedRefreshToken: string,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<boolean> {
  const db = await getDb();
  const nowMs = Date.now();
  const leaseUntil = String(nowMs + leaseMs);
  const nowIso = new Date().toISOString();
  const nowMsStr = String(nowMs);

  // Lease is free when null/empty or expired. Compare as text epoch-ms (zero-padded not required —
  // numeric strings compare correctly while lengths match; expired leases are always older/shorter-lived).
  const updated = await db
    .update(personalFplAuth)
    .set({
      refreshLeaseUntil: leaseUntil,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(personalFplAuth.id, ROW_ID),
        eq(personalFplAuth.refreshToken, expectedRefreshToken),
        or(
          isNull(personalFplAuth.refreshLeaseUntil),
          eq(personalFplAuth.refreshLeaseUntil, ""),
          sql`CAST(${personalFplAuth.refreshLeaseUntil} AS INTEGER) < ${nowMs}`,
        ),
      ),
    )
    .returning({ id: personalFplAuth.id });

  if (Array.isArray(updated) && updated.length > 0) return true;

  // Driver may omit returning — verify lease belongs to us.
  const [row] = await db.select().from(personalFplAuth).where(eq(personalFplAuth.id, ROW_ID)).limit(1);
  return Boolean(
    row &&
      row.refreshToken === expectedRefreshToken &&
      row.refreshLeaseUntil === leaseUntil,
  );
}

/** Clear lease without changing tokens (e.g. exchange failed before persist). */
export async function clearRefreshLease(expectedRefreshToken: string): Promise<void> {
  const db = await getDb();
  await db
    .update(personalFplAuth)
    .set({ refreshLeaseUntil: null, updatedAt: new Date().toISOString() })
    .where(and(eq(personalFplAuth.id, ROW_ID), eq(personalFplAuth.refreshToken, expectedRefreshToken)));
}

/**
 * When D1's refresh token is dead (invalid_grant) but the Worker secret was
 * re-seeded with a newer bare refresh_token, adopt the seed if it differs.
 * Never adopts truncated oidc.user JSON (Worker secret 5 KB cap).
 */
export async function tryAdoptEnvSeedRefreshToken(
  env: PersonalTransferEnv,
  failedRefreshToken: string,
): Promise<PersonalAuthSession | null> {
  const seeded = env[PERSONAL_FPL_REFRESH_TOKEN_ENV];
  if (!seeded?.trim()) return null;
  const token = extractRefreshToken(seeded);
  if (!token || token === failedRefreshToken) return null;
  const session: PersonalAuthSession = { refreshToken: token, accessToken: null, accessExpiresAtMs: null };
  await persistPersonalAuthSession(session);
  return session;
}
