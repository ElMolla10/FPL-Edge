import assert from "node:assert/strict";
import test from "node:test";
import { createCheckoutRoute } from "../app/api/billing/checkout/route.ts";
import type { UserRecord } from "../app/lib/auth-core.ts";
import type { PaymobGateway } from "../app/lib/billing/paymob-gateway.ts";
import type { PendingPaymentsRepo } from "../app/lib/billing/pending-payments.ts";

const user: UserRecord = { id: "u1", email: "a@example.com", passwordHash: null, chatgptLinkedAt: null };

function makeMockGateway(overrides: Partial<PaymobGateway> = {}): PaymobGateway {
  return {
    createCheckoutSession: async () => ({ orderId: "order_test", url: "https://accept.paymob.com/test" }),
    verifyAndParseCallback: async () => {
      throw new Error("not used in this test");
    },
    ...overrides,
  };
}

function makeInMemoryPendingPayments(): PendingPaymentsRepo & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    async record(orderId, userId) {
      rows.set(orderId, userId);
    },
    async findUserId(orderId) {
      return rows.get(orderId) ?? null;
    },
  };
}

test("checkout route: 401 when signed out", async () => {
  const POST = createCheckoutRoute(
    async () => null,
    async () => makeMockGateway(),
    async () => 5000,
    async () => makeInMemoryPendingPayments()
  );
  const response = await POST(new Request("https://fpl.example/api/billing/checkout", { method: "POST" }));
  assert.equal(response.status, 401);
});

test("checkout route: returns the gateway's checkout URL and records the order-id-to-user mapping", async () => {
  const pendingPayments = makeInMemoryPendingPayments();
  const gateway = makeMockGateway({
    createCheckoutSession: async () => ({ orderId: "order_test", url: "https://accept.paymob.com/test" }),
  });
  const POST = createCheckoutRoute(
    async () => user,
    async () => gateway,
    async () => 5000,
    async () => pendingPayments
  );
  const response = await POST(new Request("https://fpl.example/api/billing/checkout", { method: "POST" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.url, "https://accept.paymob.com/test");
  assert.equal(pendingPayments.rows.get("order_test"), "u1");
});

test("checkout route: passes the real season price through to the gateway", async () => {
  let seenAmountCents: number | undefined;
  const gateway = makeMockGateway({
    createCheckoutSession: async (params) => {
      seenAmountCents = params.amountCents;
      return { orderId: "order_test", url: "https://accept.paymob.com/test" };
    },
  });
  const POST = createCheckoutRoute(
    async () => user,
    async () => gateway,
    async () => 12345,
    async () => makeInMemoryPendingPayments()
  );
  await POST(new Request("https://fpl.example/api/billing/checkout", { method: "POST" }));
  assert.equal(seenAmountCents, 12345);
});

test("checkout route: 500 if the gateway throws (e.g. Paymob auth/order/payment-key request fails)", async () => {
  const gateway = makeMockGateway({
    createCheckoutSession: async () => {
      throw new Error("Paymob order registration failed: 500");
    },
  });
  const POST = createCheckoutRoute(
    async () => user,
    async () => gateway,
    async () => 5000,
    async () => makeInMemoryPendingPayments()
  );
  const response = await POST(new Request("https://fpl.example/api/billing/checkout", { method: "POST" }));
  assert.equal(response.status, 500);
});
