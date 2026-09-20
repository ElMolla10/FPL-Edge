import { getCurrentUser } from "../../../../lib/auth";
import {
  evaluatePersonalAuthManageGate,
  parseRefreshTokenInput,
  persistPersonalAuthSession,
} from "../../../../lib/personal-fpl-transfer";
import { readRuntimeEnv } from "../../../../lib/runtime-env";

/**
 * Allowlisted signed-in user pastes oidc.user JSON / refresh_token once.
 * Writes the new seed to D1 personal_fpl_auth. Never logs the token.
 * Does not require EXEC kill switch (live overlay reconnect).
 */
export async function POST(request: Request) {
  const env = await readRuntimeEnv();
  const user = await getCurrentUser();
  const gate = evaluatePersonalAuthManageGate(env, user?.email ?? null);
  if (!gate.ok) {
    return Response.json({ ok: false, error: gate.reason }, { status: gate.reason === "unauthenticated" ? 401 : 403 });
  }

  let body: { token?: unknown };
  try {
    body = (await request.json()) as { token?: unknown };
  } catch {
    return Response.json({ ok: false, error: "invalid-json" }, { status: 400 });
  }

  const raw = typeof body.token === "string" ? body.token : "";
  const refreshToken = parseRefreshTokenInput(raw);
  if (!refreshToken || refreshToken.length < 20) {
    return Response.json({ ok: false, error: "missing-token" }, { status: 400 });
  }

  // Never log token / oidc blob.
  await persistPersonalAuthSession({
    refreshToken,
    accessToken: null,
    accessExpiresAtMs: null,
  });

  return Response.json(
    { ok: true, entryId: gate.entryId },
    { headers: { "Cache-Control": "no-store" } },
  );
}
