import { isMissingTableError } from "../../../../db";
import type { UserRepo } from "../../../lib/auth-core";
import { makeD1UserRepo } from "../../../lib/auth";
import { getStripeEnv } from "../../../lib/billing/env";
import { makeStripeGateway, StripeGateway } from "../../../lib/billing/stripe-gateway";
import { handleStripeEventWith, WebhookEventLike } from "../../../lib/billing/webhook-handler";

// DI'd on the gateway and repo so this can be unit-tested end-to-end against mocks -- no real
// Stripe test-mode credentials exist yet (see tests/billing-webhook.test.mts).
export function createWebhookRoute(repo: () => Promise<UserRepo>, gateway: () => Promise<{ stripe: StripeGateway; webhookSecret: string }>) {
  return async function POST(request: Request): Promise<Response> {
    const signature = request.headers.get("stripe-signature");
    if (!signature) return Response.json({ error: "Missing stripe-signature header." }, { status: 400 });

    // Must be the raw, unparsed body -- Stripe's signature is computed over the exact bytes sent.
    const payload = await request.text();

    try {
      const { stripe, webhookSecret } = await gateway();
      const event = await stripe.constructWebhookEvent(payload, signature, webhookSecret);
      const result = await handleStripeEventWith(await repo(), event as unknown as WebhookEventLike);
      return Response.json(result);
    } catch (error) {
      console.error("billing webhook error:", error);
      if (isMissingTableError(error)) {
        return Response.json({ error: "The database schema isn't set up yet. Apply the migration (see README.md) and try again." }, { status: 503 });
      }
      // A bad/unverifiable signature is a 400 (client's fault), not a 500 -- Stripe retries 5xx
      // responses, which is wasted effort for a signature that will never verify.
      return Response.json({ error: "Webhook signature verification failed." }, { status: 400 });
    }
  };
}

export const POST = createWebhookRoute(
  async () => makeD1UserRepo(),
  async () => {
    const { secretKey, webhookSecret, priceId } = await getStripeEnv();
    return { stripe: makeStripeGateway(secretKey, priceId), webhookSecret };
  }
);
