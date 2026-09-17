// Pure event-handling logic, independent of the real Stripe SDK type -- takes a minimal shape
// of the fields each event actually needs, so tests/billing-webhook.test.mts can construct fake
// events directly without needing a real (or mocked) Stripe.Event object graph.

import type { UserRepo } from "../auth-core";
import { grantProEntitlementWith, revokeProEntitlementWith, SEASON_END_DATE_PLACEHOLDER } from "./entitlement";

export type WebhookEventLike =
  | { type: "checkout.session.completed"; data: { object: { client_reference_id: string | null; customer: string | null } } }
  | { type: "payment_intent.payment_failed"; data: { object: unknown } }
  | { type: "charge.refunded"; data: { object: { customer: string | null } } }
  | { type: string; data: { object: unknown } };

export type WebhookHandlingResult = { handled: boolean; note: string };

// Mapping ratified in the Phase 3 design checkpoint for the one-time-seasonal-payment model
// (there's no real subscription to renew/cancel, so this replaces the usual
// renewal/failure/cancellation trio): checkout.session.completed grants, payment_intent.payment_failed
// is a no-op (the customer simply never completed a checkout), charge.refunded revokes.
export async function handleStripeEventWith(repo: UserRepo, event: WebhookEventLike): Promise<WebhookHandlingResult> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as { client_reference_id: string | null; customer: string | null };
      if (!session.client_reference_id) {
        return { handled: false, note: "checkout.session.completed with no client_reference_id -- cannot resolve to a user" };
      }
      await grantProEntitlementWith(repo, session.client_reference_id, SEASON_END_DATE_PLACEHOLDER, session.customer);
      return { handled: true, note: `granted pro to user ${session.client_reference_id}` };
    }
    case "payment_intent.payment_failed":
      // No-op: the checkout was never completed, so there's no entitlement to revoke and nothing
      // was ever granted for this attempt.
      return { handled: true, note: "payment_intent.payment_failed is a no-op by design" };
    case "charge.refunded": {
      const charge = event.data.object as { customer: string | null };
      if (!charge.customer) {
        return { handled: false, note: "charge.refunded with no customer id -- cannot resolve to a user" };
      }
      const user = await repo.findByStripeCustomerId(charge.customer);
      if (!user) {
        return { handled: false, note: `charge.refunded for unknown Stripe customer ${charge.customer}` };
      }
      await revokeProEntitlementWith(repo, user.id);
      return { handled: true, note: `revoked pro from user ${user.id}` };
    }
    default:
      return { handled: false, note: `unhandled event type: ${event.type}` };
  }
}
