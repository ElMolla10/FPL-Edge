import { getCurrentUser } from "../../../../lib/auth";
import {
  evaluatePersonalAuthManageGate,
  exchangeRefreshToken,
  extractRefreshToken,
  persistPersonalAuthSession,
} from "../../../../lib/personal-fpl-transfer";
import { readRuntimeEnv } from "../../../../lib/runtime-env";

/**
 * Allowlisted signed-in user reconnects FPL by submitting a refresh_token
 * (bookmarklet or bare token). Validates via PingOne exchange, then stores
 * ONLY refresh_token + access cache in D1 — never whole oidc.user JSON.
 * Does not require EXEC kill switch (live overlay reconnect).
 */
export async function POST(request: Request) {
  const env = await readRuntimeEnv();
  const user = await getCurrentUser();
  const gate = evaluatePersonalAuthManageGate(env, user?.email ?? null);
  if (gate.ok === false) {
    return Response.json(
      { ok: false, error: gate.reason },
      { status: gate.reason === "unauthenticated" ? 401 : 403 },
    );
  }

  let body: { token?: unknown };
  try {
    body = (await request.json()) as { token?: unknown };
  } catch {
    return Response.json({ ok: false, error: "invalid-json" }, { status: 400 });
  }

  const raw = typeof body.token === "string" ? body.token : "";
  const refreshToken = extractRefreshToken(raw);
  if (!refreshToken || refreshToken.length < 20) {
    return Response.json({ ok: false, error: "missing-token" }, { status: 400 });
  }

  // Prove the token works and capture the rotated pair before persisting.
  // Never log token / oidc blob.
  let accessToken: string;
  let nextRefresh: string;
  let expiresInSeconds: number;
  try {
    const exchanged = await exchangeRefreshToken(refreshToken);
    accessToken = exchanged.accessToken;
    nextRefresh = exchanged.refreshToken;
    expiresInSeconds = exchanged.expiresInSeconds;
  } catch {
    return Response.json({ ok: false, error: "token-invalid" }, { status: 400 });
  }

  await persistPersonalAuthSession({
    refreshToken: nextRefresh,
    accessToken,
    accessExpiresAtMs: Date.now() + expiresInSeconds * 1000 - 15_000,
  });

  return Response.json(
    { ok: true, entryId: gate.entryId },
    { headers: { "Cache-Control": "no-store" } },
  );
}
