import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { personalFplAuth } from "../../../db/schema";
import { PERSONAL_FPL_REFRESH_TOKEN_ENV, parseRefreshTokenInput, type PersonalTransferEnv } from "./config";

const ROW_ID = "default";

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
  const token = parseRefreshTokenInput(seeded);
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
    updatedAt: now,
  });
}

/**
 * Compare-and-swap refresh token update. Returns false when another isolate
 * already rotated away from `expectedRefreshToken` — caller should reload.
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
 * When D1's refresh token is dead (invalid_grant) but the Worker secret was
 * re-seeded with a newer oidc.user blob, adopt the seed if it differs.
 */
export async function tryAdoptEnvSeedRefreshToken(
  env: PersonalTransferEnv,
  failedRefreshToken: string,
): Promise<PersonalAuthSession | null> {
  const seeded = env[PERSONAL_FPL_REFRESH_TOKEN_ENV];
  if (!seeded?.trim()) return null;
  const token = parseRefreshTokenInput(seeded);
  if (!token || token === failedRefreshToken) return null;
  const session: PersonalAuthSession = { refreshToken: token, accessToken: null, accessExpiresAtMs: null };
  await persistPersonalAuthSession(session);
  return session;
}
