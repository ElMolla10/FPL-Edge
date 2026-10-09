import { getCurrentUser } from "../../../../lib/auth";
import { BodyError, isPlainObject, readJsonBody, rejectCrossSite } from "../../../../lib/request-guards";
import { readRuntimeEnv } from "../../../../lib/runtime-env";
import { exchangeRefreshToken } from "../../../../lib/personal-fpl-transfer/oidc";
import { extractRefreshToken } from "../../../../lib/personal-fpl-transfer/config";
import { BOT_ENV, WrongEntryError, assertBotEntry, evaluateBotOwnerGate } from "../../../../lib/fpl-bot/config";
import { BotKeyError, importBotKey } from "../../../../lib/fpl-bot/crypto";
import { botDb } from "../../../../lib/fpl-bot/d1";
import { fetchMeEntryWithAccessToken, fetchPublicTeamName } from "../../../../lib/fpl-bot/fpl-client";
import { recordBotError, storeBotBootstrap } from "../../../../lib/fpl-bot/store";

const JWTISH = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/**
 * Connect the BOT's FPL account (bookmarklet run on fantasy.premierleague.com while signed in AS THE BOT).
 * Wrong-account rejection: GET /api/me must report the configured bot entry; otherwise nothing is stored. When the
 * bookmarklet also sends the (short-lived) access token, identity is checked BEFORE the refresh token is exchanged,
 * so running it in the wrong (personal) browser profile does not rotate that profile's session.
 * Stores only the rotated refresh token + access cache, AES-GCM encrypted. Never echoes tokens.
 */
export async function POST(request: Request) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  const env = await readRuntimeEnv();
  const user = await getCurrentUser();
  const gate = evaluateBotOwnerGate(env, user?.email ?? null);
  if (!gate.ok) return Response.json({ ok: false, error: gate.reason }, { status: gate.reason === "unauthenticated" ? 401 : 403 });

  let body: Record<string, unknown>;
  try {
    const parsed = await readJsonBody(request);
    if (!isPlainObject(parsed)) return Response.json({ ok: false, error: "invalid-json" }, { status: 400 });
    body = parsed;
  } catch (error) {
    if (error instanceof BodyError) return Response.json({ ok: false, error: error.status === 413 ? "too-large" : "invalid-json" }, { status: error.status });
    return Response.json({ ok: false, error: "invalid-json" }, { status: 400 });
  }

  let botEntry: string;
  try {
    botEntry = assertBotEntry(env);
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof WrongEntryError && /personal/.test(error.message) ? "bot-entry-equals-personal" : "missing-bot-entry" }, { status: 409 });
  }
  let key: CryptoKey;
  try {
    key = await importBotKey(env[BOT_ENV.tokenKey]);
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof BotKeyError ? "missing-token-key" : "key-error" }, { status: 409 });
  }

  const refreshToken = extractRefreshToken(typeof body.refreshToken === "string" ? body.refreshToken : "");
  if (!refreshToken || refreshToken.length < 20) return Response.json({ ok: false, error: "missing-token" }, { status: 400 });
  const accessRaw = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
  const db = await botDb();
  const now = Date.now();

  // 1. Identity first with the browser's own access token (no rotation) when available.
  let identityChecked = false;
  if (accessRaw && accessRaw.length < 8192 && JWTISH.test(accessRaw)) {
    const me = await fetchMeEntryWithAccessToken(accessRaw).catch(() => ({ status: 0, entry: null }));
    if (me.entry !== null) {
      if (me.entry !== botEntry) {
        await recordBotError(db, "reconnect-wrong-account", "bookmarklet ran in a session that is not the bot team", now);
        return Response.json({ ok: false, error: "wrong-account" }, { status: 409 });
      }
      identityChecked = true;
    }
  }

  // 2. Prove the refresh token works and capture the rotated pair.
  let exchanged;
  try {
    exchanged = await exchangeRefreshToken(refreshToken);
  } catch {
    return Response.json({ ok: false, error: "token-invalid" }, { status: 400 });
  }

  // 3. Identity with the fresh access token when step 1 could not decide. Mismatch => discard, store nothing.
  if (!identityChecked) {
    const me = await fetchMeEntryWithAccessToken(exchanged.accessToken).catch(() => ({ status: 0, entry: null }));
    if (me.entry !== botEntry) {
      await recordBotError(db, me.entry ? "reconnect-wrong-account" : "reconnect-identity-unknown", null, now);
      return Response.json({ ok: false, error: me.entry ? "wrong-account" : "identity-unverified" }, { status: 409 });
    }
  }

  // 4. Optional public team-name cross-check.
  const expectedName = env[BOT_ENV.teamName]?.trim();
  if (expectedName) {
    const name = await fetchPublicTeamName(botEntry);
    if (name !== null && name.trim() !== expectedName) {
      await recordBotError(db, "reconnect-team-name-mismatch", null, now);
      return Response.json({ ok: false, error: "team-name-mismatch" }, { status: 409 });
    }
  }

  await storeBotBootstrap(
    db,
    key,
    { refreshToken: exchanged.refreshToken, accessToken: exchanged.accessToken, accessExpiresAtMs: now + exchanged.expiresInSeconds * 1000 - 15_000 },
    botEntry,
    now,
  );
  return Response.json({ ok: true, sessionStartedAt: new Date(now).toISOString() }, { headers: { "Cache-Control": "no-store" } });
}
