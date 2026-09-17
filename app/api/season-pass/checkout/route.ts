import { isMissingTableError } from "../../../../db";
import { getCurrentUser } from "../../../lib/auth";
import { paymobConfigFromEnv, createPaymobIntention } from "../../../lib/paymob";
import { readRuntimeEnv } from "../../../lib/runtime-env";
import { attachPaymobOrder, insertPendingCheckout, seasonPassSummaryForUser } from "../../../lib/season-access";
import { loadSeasonDeadlines } from "../../../lib/season-events";
import { SEASON_PASS_PRICE_PIASTERS, normalizeCheckoutPhone, resolveSeasonWindow } from "../../../lib/season-pass";

const NOT_CONNECTED = "Checkout is not connected yet.";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Sign in before checkout. A payment is attached to your account, not this browser." }, { status: 401 });

  const env = await readRuntimeEnv();
  const config = paymobConfigFromEnv(env);
  if (!config) return Response.json({ connected: false, message: NOT_CONNECTED });

  let phone = "";
  try {
    const body = (await request.json()) as { phone?: string };
    phone = normalizeCheckoutPhone(body.phone ?? "") ?? "";
  } catch {
    phone = "";
  }
  if (!phone) return Response.json({ error: "Enter an Egyptian mobile number so Paymob can open checkout." }, { status: 400 });

  try {
    const summary = await seasonPassSummaryForUser(user.id);
    if (summary.active) return Response.json({ alreadyActive: true, endsAt: summary.endsAt, seasonKey: summary.seasonKey });

    const now = new Date();
    const window = resolveSeasonWindow(await loadSeasonDeadlines(), now);
    if (Date.parse(window.endsAt) < now.getTime()) {
      return Response.json({ error: "This season's pass window has ended." }, { status: 409 });
    }

    const checkoutId = crypto.randomUUID();
    await insertPendingCheckout({
      id: checkoutId,
      userId: user.id,
      seasonKey: window.seasonKey,
      endsAt: window.endsAt,
      amountPiasters: SEASON_PASS_PRICE_PIASTERS,
    });

    const origin = new URL(request.url).origin;
    const intention = await createPaymobIntention(config, {
      specialReference: checkoutId,
      email: user.email,
      phone,
      notificationUrl: `${origin}/api/season-pass/callback`,
      redirectionUrl: `${origin}/?checkout=return`,
    });
    await attachPaymobOrder(checkoutId, intention.intentionId, intention.orderId);
    // Deliberately no active pass here. The browser is only sent to Paymob.
    return Response.json({
      connected: true,
      checkoutUrl: intention.checkoutUrl,
      seasonKey: window.seasonKey,
      endsAt: window.endsAt,
    });
  } catch (error) {
    console.error("season checkout error:", error);
    if (isMissingTableError(error)) {
      return Response.json({ error: "The database schema isn't set up yet. Apply the season-pass migration and try again." }, { status: 503 });
    }
    return Response.json({ error: "Paymob could not start checkout." }, { status: 502 });
  }
}
