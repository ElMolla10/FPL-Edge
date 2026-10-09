/**
 * Bot token lifecycle (Option A): one interactive bootstrap via the bookmarklet (reconnect route), then hourly
 * refresh-token rotation from cron. Reuses the proven single-flight / CAS rotating provider from the personal module
 * (pure, hook-based) but with the bot's own encrypted bot_fpl_auth store - never the personal store or token.
 */
import { createRotatingTokenProvider, type TokenProvider } from "../personal-fpl-transfer/client";
import { FplOidcError } from "../personal-fpl-transfer/oidc";
import { extractRefreshToken } from "../personal-fpl-transfer/config";
import { BOT_ENV, BOT_LIMITS, type BotEnv } from "./config";
import { importBotKey } from "./crypto";
import {
  casPersistBotSession,
  claimBotRefreshLease,
  clearBotRefreshLease,
  forcePersistBotSession,
  loadBotSession,
  markBotAuth,
  readBotAuthRow,
  seedBotSessionIfEmpty,
  type BotAuthRow,
  type BotDb,
} from "./store";

export type AuthFailure = "missing-key" | "missing-token" | "token-expired" | "oidc-failed" | "unknown";

export type BotTokens = { ok: true; tokens: TokenProvider; row: BotAuthRow } | { ok: false; reason: AuthFailure };

export function classifyAuthError(error: unknown): AuthFailure {
  if (error instanceof FplOidcError) return error.isInvalidGrant ? "token-expired" : "oidc-failed";
  if (error instanceof Error && /invalid_grant|expired|revoked/i.test(error.message)) return "token-expired";
  return "unknown";
}

export async function openBotTokens(env: BotEnv, db: BotDb, nowMs: number, fetchImpl: typeof fetch = fetch): Promise<BotTokens> {
  let key: CryptoKey;
  try {
    key = await importBotKey(env[BOT_ENV.tokenKey]);
  } catch {
    return { ok: false, reason: "missing-key" };
  }
  const seed = env[BOT_ENV.refreshSeed] ? extractRefreshToken(env[BOT_ENV.refreshSeed]!) : null;
  await seedBotSessionIfEmpty(db, key, seed, nowMs);
  const session = await loadBotSession(db, key);
  const row = await readBotAuthRow(db);
  if (!session || !row) return { ok: false, reason: "missing-token" };
  const tokens = await createRotatingTokenProvider(
    session,
    {
      persistSession: (expected, next) => casPersistBotSession(db, key, expected, next, Date.now()),
      reloadSession: () => loadBotSession(db, key),
      claimRefreshLease: (expected) => claimBotRefreshLease(db, expected, Date.now()),
      clearRefreshLease: (expected) => clearBotRefreshLease(db, expected),
      forcePersistSession: (next) => forcePersistBotSession(db, key, next, Date.now()),
      // No env-seed adoption after invalid_grant: a dead bot session needs a fresh bookmarklet bootstrap.
    },
    fetchImpl,
  );
  return { ok: true, tokens, row };
}

export function sessionAgeDays(row: Pick<BotAuthRow, "session_started_at"> | null, nowMs: number): number | null {
  const started = row?.session_started_at ? Date.parse(row.session_started_at) : NaN;
  return Number.isFinite(started) ? Math.max(0, (nowMs - started) / 86_400_000) : null;
}

export type SessionHealth = "ok" | "warn" | "stop-multistep" | "unknown";

export function sessionHealth(ageDays: number | null): SessionHealth {
  if (ageDays === null) return "unknown";
  if (ageDays >= BOT_LIMITS.sessionStopMultiStepDays) return "stop-multistep";
  if (ageDays >= BOT_LIMITS.sessionWarnDays) return "warn";
  return "ok";
}

/** Hourly keep-alive: refresh only when the cached access token expired (fewer rotations = fewer chances to lose the chain). */
export async function keepAliveBotTokens(env: BotEnv, db: BotDb, nowMs: number, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; tokens: TokenProvider; row: BotAuthRow } | { ok: false; reason: AuthFailure }> {
  const opened = await openBotTokens(env, db, nowMs, fetchImpl);
  if (!opened.ok) return opened;
  try {
    await opened.tokens.getAccessToken({ forceRefresh: false });
    await markBotAuth(db, nowMs, null);
    return opened;
  } catch (error) {
    const reason = classifyAuthError(error);
    await markBotAuth(db, nowMs, reason);
    return { ok: false, reason };
  }
}
