import { isMissingTableError } from "../../../../db";
import type { UserRecord } from "../../../lib/auth-core";
import { getCurrentUser } from "../../../lib/auth";
import { getPaymobEnv, getSeasonPriceEgpCents } from "../../../lib/billing/env";
import { makePaymobGateway, PaymobGateway } from "../../../lib/billing/paymob-gateway";
import { makeD1PendingPaymentsRepo, PendingPaymentsRepo } from "../../../lib/billing/pending-payments";

// DI'd on the gateway, the price, and the pending-payments repo (not the concrete Paymob SDK --
// there isn't one, it's plain fetch) so this can be unit-tested against a mock. No real Paymob
// credentials or a real price exist yet (see tests/billing-checkout.test.mts).
export function createCheckoutRoute(
  getUser: () => Promise<UserRecord | null>,
  gateway: () => Promise<PaymobGateway>,
  seasonPriceEgpCents: () => Promise<number>,
  pendingPayments: () => Promise<PendingPaymentsRepo>
) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const user = await getUser();
      if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });

      const origin = new URL(request.url).origin;
      const [paymob, amountCents] = await Promise.all([gateway(), seasonPriceEgpCents()]);
      // Opaque, unique per checkout attempt -- Paymob's own order id (not this value) is what the
      // callback carries and what pendingPayments is keyed on; this is only Paymob's
      // merchant_order_id echo-back for our own logs/dashboard readability.
      const merchantOrderId = `fpl-edge-${user.id}-${Date.now()}`;
      const session = await paymob.createCheckoutSession({
        amountCents,
        merchantOrderId,
        billingEmail: user.email,
        billingName: user.email.split("@")[0] ?? "FPL Edge",
        successUrl: `${origin}/?checkout=success`,
        cancelUrl: `${origin}/?checkout=cancelled`,
      });

      const repo = await pendingPayments();
      await repo.record(session.orderId, user.id);

      return Response.json({ url: session.url });
    } catch (error) {
      console.error("billing checkout error:", error);
      if (isMissingTableError(error)) {
        return Response.json({ error: "The database schema isn't set up yet. Apply the migration (see README.md) and try again." }, { status: 503 });
      }
      return Response.json({ error: "Could not start checkout." }, { status: 500 });
    }
  };
}

export const POST = createCheckoutRoute(
  getCurrentUser,
  async () => {
    const { apiKey, integrationId, hmacSecret, iframeId } = await getPaymobEnv();
    return makePaymobGateway(apiKey, integrationId, hmacSecret, iframeId);
  },
  getSeasonPriceEgpCents,
  async () => makeD1PendingPaymentsRepo()
);
