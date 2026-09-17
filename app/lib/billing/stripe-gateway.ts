// Thin wrapper around the Stripe SDK -- isolates the two Workers-specific gotchas (fetch-based
// HTTP client instead of Node's `https`; `constructEventAsync` instead of the sync
// `constructEvent`, which needs Node's `crypto` and throws in the Workers runtime) behind a
// small interface. app/api/billing/* routes depend on this interface, not on Stripe directly,
// so tests can inject a mock (see tests/billing-webhook.test.mts) -- built this way because no
// real Stripe test-mode credentials exist yet; a real StripeGateway is wired in once they do.
import Stripe from "stripe";

export type CheckoutSessionResult = { id: string; url: string | null };

export type StripeGateway = {
  // clientReferenceId (our internal user id) rides through to the checkout.session.completed
  // event untouched -- that's how the webhook handler resolves the grant back to a user without
  // any lookup. When customerId is null, customer_creation:"always" guarantees Stripe still
  // attaches a Customer to the session, so session.customer is populated on completion; the
  // webhook handler persists that as the user's stripeCustomerId for later refund lookups.
  createCheckoutSession(params: {
    customerId: string | null;
    customerEmail: string;
    clientReferenceId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutSessionResult>;
  constructWebhookEvent(payload: string, signature: string, webhookSecret: string): Promise<Stripe.Event>;
};

export function makeStripeGateway(secretKey: string, priceId: string): StripeGateway {
  const stripe = new Stripe(secretKey, { httpClient: Stripe.createFetchHttpClient() });

  return {
    async createCheckoutSession({ customerId, customerEmail, clientReferenceId, successUrl, cancelUrl }) {
      const session = await stripe.checkout.sessions.create({
        mode: "payment", // one seasonal payment, not a subscription -- see db/schema.ts's entitlementExpiresAt
        line_items: [{ price: priceId, quantity: 1 }],
        customer: customerId ?? undefined,
        customer_email: customerId ? undefined : customerEmail,
        customer_creation: customerId ? undefined : "always",
        client_reference_id: clientReferenceId,
        success_url: successUrl,
        cancel_url: cancelUrl,
      });
      return { id: session.id, url: session.url };
    },
    async constructWebhookEvent(payload, signature, webhookSecret) {
      return stripe.webhooks.constructEventAsync(payload, signature, webhookSecret);
    },
  };
}
