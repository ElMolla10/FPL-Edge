import assert from "node:assert/strict";
import test from "node:test";
import { handleStripeEventWith } from "../app/lib/billing/webhook-handler.ts";
import { SEASON_END_DATE_PLACEHOLDER } from "../app/lib/billing/entitlement.ts";
import type { UserRecord, UserRepo } from "../app/lib/auth-core.ts";

function makeInMemoryRepo(seed: UserRecord[] = []): UserRepo {
  const rows = new Map<string, UserRecord>(seed.map((u) => [u.id, { ...u }]));
  return {
    async findByEmail(email) {
      for (const row of rows.values()) if (row.email === email) return { ...row };
      return null;
    },
    async findByStripeCustomerId(stripeCustomerId) {
      for (const row of rows.values()) if (row.stripeCustomerId === stripeCustomerId) return { ...row };
      return null;
    },
    async insert(user) {
      rows.set(user.id, { ...user });
    },
    async update(id, patch) {
      const existing = rows.get(id);
      if (existing) rows.set(id, { ...existing, ...patch });
    },
  };
}

test("checkout.session.completed: grants pro to the user named by client_reference_id and stores the Stripe customer id", async () => {
  const repo = makeInMemoryRepo([{ id: "u1", email: "a@example.com", passwordHash: null, chatgptLinkedAt: null, entitlementStatus: "free" }]);
  const result = await handleStripeEventWith(repo, {
    type: "checkout.session.completed",
    data: { object: { client_reference_id: "u1", customer: "cus_123" } },
  });
  assert.equal(result.handled, true);
  const user = await repo.findByEmail("a@example.com");
  assert.equal(user?.entitlementStatus, "pro");
  assert.equal(user?.entitlementExpiresAt, SEASON_END_DATE_PLACEHOLDER);
  assert.equal(user?.stripeCustomerId, "cus_123");
});

test("checkout.session.completed: not handled if there's no client_reference_id to resolve to a user", async () => {
  const repo = makeInMemoryRepo();
  const result = await handleStripeEventWith(repo, {
    type: "checkout.session.completed",
    data: { object: { client_reference_id: null, customer: "cus_123" } },
  });
  assert.equal(result.handled, false);
});

test("payment_intent.payment_failed: is a no-op, never touches any user row", async () => {
  const repo = makeInMemoryRepo([{ id: "u1", email: "a@example.com", passwordHash: null, chatgptLinkedAt: null, entitlementStatus: "free" }]);
  const result = await handleStripeEventWith(repo, { type: "payment_intent.payment_failed", data: { object: {} } });
  assert.equal(result.handled, true);
  const user = await repo.findByEmail("a@example.com");
  assert.equal(user?.entitlementStatus, "free");
});

test("charge.refunded: revokes pro from the user matching the Stripe customer id, keeps stripeCustomerId on the row", async () => {
  const repo = makeInMemoryRepo([
    { id: "u1", email: "a@example.com", passwordHash: null, chatgptLinkedAt: null, entitlementStatus: "pro", entitlementExpiresAt: SEASON_END_DATE_PLACEHOLDER, stripeCustomerId: "cus_123" },
  ]);
  const result = await handleStripeEventWith(repo, { type: "charge.refunded", data: { object: { customer: "cus_123" } } });
  assert.equal(result.handled, true);
  const user = await repo.findByEmail("a@example.com");
  assert.equal(user?.entitlementStatus, "free");
  assert.equal(user?.entitlementExpiresAt, null);
  assert.equal(user?.stripeCustomerId, "cus_123");
});

test("charge.refunded: not handled if the Stripe customer id doesn't match any user", async () => {
  const repo = makeInMemoryRepo();
  const result = await handleStripeEventWith(repo, { type: "charge.refunded", data: { object: { customer: "cus_unknown" } } });
  assert.equal(result.handled, false);
});

test("unrecognized event types are reported as unhandled rather than throwing", async () => {
  const repo = makeInMemoryRepo();
  const result = await handleStripeEventWith(repo, { type: "customer.created", data: { object: {} } });
  assert.equal(result.handled, false);
});
