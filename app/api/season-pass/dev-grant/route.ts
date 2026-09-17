import { isMissingTableError } from "../../../../db";
import { getCurrentUser } from "../../../lib/auth";
import { readRuntimeEnv } from "../../../lib/runtime-env";
import { insertSeasonPass, seasonPassSummaryForUser } from "../../../lib/season-access";
import { loadSeasonDeadlines } from "../../../lib/season-events";
import { SEASON_PASS_PRICE_PIASTERS, devSeasonGrantEnabled, resolveSeasonWindow } from "../../../lib/season-pass";

// Not linked from the UI. Refuses unless FPL_EDGE_DEV_SEASON_GRANT=1 and NODE_ENV is
// development or test. Production and an unset NODE_ENV cannot hit this.
export async function POST() {
  const env = await readRuntimeEnv();
  if (!devSeasonGrantEnabled(env)) return Response.json({ error: "Not found." }, { status: 404 });

  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });

  try {
    const now = new Date();
    const existing = await seasonPassSummaryForUser(user.id, now);
    if (existing.active) return Response.json({ active: true, endsAt: existing.endsAt, seasonKey: existing.seasonKey });
    const window = resolveSeasonWindow(await loadSeasonDeadlines(), now);
    if (Date.parse(window.endsAt) < now.getTime()) return Response.json({ error: "Season window has ended." }, { status: 409 });
    await insertSeasonPass({
      id: crypto.randomUUID(),
      userId: user.id,
      seasonKey: window.seasonKey,
      startsAt: now.toISOString(),
      endsAt: window.endsAt,
      amountPiasters: SEASON_PASS_PRICE_PIASTERS,
      source: "dev-grant",
      paymobTransactionId: null,
    });
    return Response.json({ active: true, endsAt: window.endsAt, seasonKey: window.seasonKey, source: "dev-grant" });
  } catch (error) {
    console.error("dev season grant error:", error);
    if (isMissingTableError(error)) return Response.json({ error: "Schema isn't set up yet." }, { status: 503 });
    return Response.json({ error: "Could not grant." }, { status: 500 });
  }
}
