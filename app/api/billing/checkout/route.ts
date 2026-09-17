import { isMissingTableError } from "../../../../db";
import type { UserRecord } from "../../../lib/auth-core";
import { getCurrentUser } from "../../../lib/auth";
import { getStripeEnv } from "../../../lib/billing/env";
import { makeStripeGateway, StripeGateway } from "../../../lib/billing/stripe-gateway";

// DI'd on the gateway (not the concrete Stripe SDK) so this can be unit-tested against a mock --
// no real Stripe test-mode credentials exist yet (see tests/billing-checkout.test.mts).
export function createCheckoutRoute(getUser: () => Promise<UserRecord | null>, gateway: () => Promise<StripeGateway>) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const user = await getUser();
      if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });

      const origin = new URL(request.url).origin;
      const stripe = await gateway();
      const session = await stripe.createCheckoutSession({
        customerId: user.stripeCustomerId ?? null,
        customerEmail: user.email,
        clientReferenceId: user.id,
        successUrl: `${origin}/?checkout=success`,
        cancelUrl: `${origin}/?checkout=cancelled`,
      });
      if (!session.url) return Response.json({ error: "Stripe did not return a checkout URL." }, { status: 502 });
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

export const POST = createCheckoutRoute(getCurrentUser, async () => {
  const { secretKey, priceId } = await getStripeEnv();
  return makeStripeGateway(secretKey, priceId);
});
