import assert from "node:assert/strict";
import test from "node:test";
import { createCheckoutRoute } from "../app/api/billing/checkout/route.ts";
import type { UserRecord } from "../app/lib/auth-core.ts";
import type { StripeGateway } from "../app/lib/billing/stripe-gateway.ts";

const user: UserRecord = { id: "u1", email: "a@example.com", passwordHash: null, chatgptLinkedAt: null };

function makeMockGateway(overrides: Partial<StripeGateway> = {}): StripeGateway {
  return {
    createCheckoutSession: async () => ({ id: "cs_test", url: "https://checkout.stripe.com/test" }),
    constructWebhookEvent: async () => {
      throw new Error("not used in this test");
    },
    ...overrides,
  };
}

test("checkout route: 401 when signed out", async () => {
  const POST = createCheckoutRoute(async () => null, async () => makeMockGateway());
  const response = await POST(new Request("https://fpl.example/api/billing/checkout", { method: "POST" }));
  assert.equal(response.status, 401);
});

test("checkout route: returns the gateway's checkout URL, passing the signed-in user's id as client_reference_id", async () => {
  let seenClientReferenceId: string | undefined;
  const gateway = makeMockGateway({
    createCheckoutSession: async (params) => {
      seenClientReferenceId = params.clientReferenceId;
      return { id: "cs_test", url: "https://checkout.stripe.com/test" };
    },
  });
  const POST = createCheckoutRoute(async () => user, async () => gateway);
  const response = await POST(new Request("https://fpl.example/api/billing/checkout", { method: "POST" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.url, "https://checkout.stripe.com/test");
  assert.equal(seenClientReferenceId, "u1");
});

test("checkout route: 502 if Stripe returns no checkout URL", async () => {
  const gateway = makeMockGateway({ createCheckoutSession: async () => ({ id: "cs_test", url: null }) });
  const POST = createCheckoutRoute(async () => user, async () => gateway);
  const response = await POST(new Request("https://fpl.example/api/billing/checkout", { method: "POST" }));
  assert.equal(response.status, 502);
});
