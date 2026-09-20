/**
 * Cron / scheduled keep-alive for the personal FPL OIDC refresh token.
 *
 * PingOne rotates refresh tokens on exchange; unused tokens eventually die.
 * This path periodically exchanges (via the same CAS/cache stack as live overlay)
 * so the token stays alive even when nobody opens Transfers.
 *
 * On token-expired: do not invent bank — leave overlay unavailable for reconnect.
 */

import { createRotatingTokenProvider } from "./client";
import { personalFplEntryId, type PersonalTransferEnv } from "./config";
import { FplOidcError } from "./oidc";
import {
  casPersistPersonalAuthSession,
  claimRefreshLease,
  clearRefreshLease,
  loadPersonalAuthSession,
  persistPersonalAuthSession,
  reloadPersonalAuthSessionFromDb,
  tryAdoptEnvSeedRefreshToken,
} from "./store";

export type KeepAliveResult =
  | { ok: true; refreshed: boolean }
  | {
      ok: false;
      reason:
        | "missing-entry-config"
        | "missing-refresh-token"
        | "token-expired"
        | "oidc-failed"
        | "unknown";
    };

function classifyFailure(error: unknown): Extract<KeepAliveResult, { ok: false }> {
  if (error instanceof FplOidcError) {
    if (error.isInvalidGrant) return { ok: false, reason: "token-expired" };
    return { ok: false, reason: "oidc-failed" };
  }
  if (error instanceof Error && /invalid_grant|expired|revoked/i.test(error.message)) {
    return { ok: false, reason: "token-expired" };
  }
  return { ok: false, reason: "unknown" };
}

/**
 * Ensure a usable access token exists in D1 (refreshing via CAS when needed).
 * Never logs token material.
 */
export async function keepAlivePersonalFplAuth(env: PersonalTransferEnv): Promise<KeepAliveResult> {
  const entryId = personalFplEntryId(env);
  if (!entryId) return { ok: false, reason: "missing-entry-config" };

  const session = await loadPersonalAuthSession(env);
  if (!session) return { ok: false, reason: "missing-refresh-token" };

  const hadValidAccess =
    Boolean(session.accessToken) &&
    session.accessExpiresAtMs !== null &&
    Date.now() < session.accessExpiresAtMs;

  try {
    const tokens = await createRotatingTokenProvider(session, {
      persistSession: casPersistPersonalAuthSession,
      reloadSession: reloadPersonalAuthSessionFromDb,
      adoptEnvSeed: (failed) => tryAdoptEnvSeedRefreshToken(env, failed),
      claimRefreshLease: (expected) => claimRefreshLease(expected),
      clearRefreshLease: (expected) => clearRefreshLease(expected),
      forcePersistSession: (next) => persistPersonalAuthSession(next),
    });
    // Prefer cached access when still valid (avoids race-rotating with concurrent
    // /api/fpl/team). When expired (typical after idle hours), exchange + CAS persist.
    await tokens.getAccessToken({ forceRefresh: false });
    return { ok: true, refreshed: !hadValidAccess };
  } catch (error) {
    const failed = classifyFailure(error);
    console.warn(`[fpl-token-keepalive] ${failed.reason}`);
    return failed;
  }
}
