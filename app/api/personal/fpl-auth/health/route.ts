import { getCurrentUser } from "../../../../lib/auth";
import {
  evaluatePersonalAuthManageGate,
  reloadPersonalAuthSessionFromDb,
  tryFetchLiveTeamFinance,
} from "../../../../lib/personal-fpl-transfer";
import { readRuntimeEnv } from "../../../../lib/runtime-env";

/** Allowlisted-only: whether live overlay works. Never returns tokens. */
export async function GET() {
  const env = await readRuntimeEnv();
  const user = await getCurrentUser();
  const gate = evaluatePersonalAuthManageGate(env, user?.email ?? null);
  if (!gate.ok) {
    return Response.json({ ok: false, error: gate.reason }, { status: gate.reason === "unauthenticated" ? 401 : 403 });
  }

  const session = await reloadPersonalAuthSessionFromDb();
  const attempt = await tryFetchLiveTeamFinance(gate.entryId, env);

  return Response.json(
    {
      ok: true,
      entryId: gate.entryId,
      hasRefreshToken: Boolean(session?.refreshToken),
      hasCachedAccess: Boolean(
        session?.accessToken &&
          session.accessExpiresAtMs !== null &&
          Date.now() < session.accessExpiresAtMs,
      ),
      liveOverlay: attempt.ok,
      liveOverlayError: attempt.ok ? null : attempt.error,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
