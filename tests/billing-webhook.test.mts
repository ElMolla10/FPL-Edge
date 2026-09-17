import assert from "node:assert/strict";
import test from "node:test";
import { handlePaymobTransactionWith } from "../app/lib/billing/webhook-handler.ts";
import { SEASON_END_DATE_PLACEHOLDER } from "../app/lib/billing/entitlement.ts";
import type { UserRecord, UserRepo } from "../app/lib/auth-core.ts";
import type { PendingPaymentsRepo } from "../app/lib/billing/pending-payments.ts";

function makeInMemoryUserRepo(seed: UserRecord[] = []): UserRepo {
  const rows = new Map<string, UserRecord>(seed.map((u) => [u.id, { ...u }]));
  return {
    async findByEmail(email) {
      for (const row of rows.values()) if (row.email === email) return { ...row };
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

function makeInMemoryPendingPayments(seed: Record<string, string> = {}): PendingPaymentsRepo {
  const rows = new Map<string, string>(Object.entries(seed));
  return {
    async record(orderId, userId) {
      rows.set(orderId, userId);
    },
    async findUserId(orderId) {
      return rows.get(orderId) ?? null;
    },
  };
}

test("success (not pending, not refunded/voided): grants pro to the user the order id resolves to", async () => {
  const userRepo = makeInMemoryUserRepo([{ id: "u1", email: "a@example.com", passwordHash: null, chatgptLinkedAt: null, entitlementStatus: "free" }]);
  const pendingPayments = makeInMemoryPendingPayments({ order_1: "u1" });
  const result = await handlePaymobTransactionWith(userRepo, pendingPayments, {
    orderId: "order_1",
    success: true,
    pending: false,
    isRefunded: false,
    isVoided: false,
  });
  assert.equal(result.handled, true);
  const user = await userRepo.findByEmail("a@example.com");
  assert.equal(user?.entitlementStatus, "pro");
  assert.equal(user?.entitlementExpiresAt, SEASON_END_DATE_PLACEHOLDER);
});

test("success for an order id with no pendingPayments record: not handled, never grants blindly", async () => {
  const userRepo = makeInMemoryUserRepo();
  const pendingPayments = makeInMemoryPendingPayments();
  const result = await handlePaymobTransactionWith(userRepo, pendingPayments, {
    orderId: "order_unknown",
    success: true,
    pending: false,
    isRefunded: false,
    isVoided: false,
  });
  assert.equal(result.handled, false);
});

test("pending transaction: no-op, never touches any user row", async () => {
  const userRepo = makeInMemoryUserRepo([{ id: "u1", email: "a@example.com", passwordHash: null, chatgptLinkedAt: null, entitlementStatus: "free" }]);
  const pendingPayments = makeInMemoryPendingPayments({ order_1: "u1" });
  const result = await handlePaymobTransactionWith(userRepo, pendingPayments, {
    orderId: "order_1",
    success: false,
    pending: true,
    isRefunded: false,
    isVoided: false,
  });
  assert.equal(result.handled, true);
  const user = await userRepo.findByEmail("a@example.com");
  assert.equal(user?.entitlementStatus, "free");
});

test("outright failed transaction (success:false, not pending): no-op, nothing was ever granted", async () => {
  const userRepo = makeInMemoryUserRepo([{ id: "u1", email: "a@example.com", passwordHash: null, chatgptLinkedAt: null, entitlementStatus: "free" }]);
  const pendingPayments = makeInMemoryPendingPayments({ order_1: "u1" });
  const result = await handlePaymobTransactionWith(userRepo, pendingPayments, {
    orderId: "order_1",
    success: false,
    pending: false,
    isRefunded: false,
    isVoided: false,
  });
  assert.equal(result.handled, true);
  const user = await userRepo.findByEmail("a@example.com");
  assert.equal(user?.entitlementStatus, "free");
});

test("is_refunded: revokes pro from the user the order id resolves to", async () => {
  const userRepo = makeInMemoryUserRepo([
    { id: "u1", email: "a@example.com", passwordHash: null, chatgptLinkedAt: null, entitlementStatus: "pro", entitlementExpiresAt: SEASON_END_DATE_PLACEHOLDER },
  ]);
  const pendingPayments = makeInMemoryPendingPayments({ order_1: "u1" });
  const result = await handlePaymobTransactionWith(userRepo, pendingPayments, {
    orderId: "order_1",
    success: true,
    pending: false,
    isRefunded: true,
    isVoided: false,
  });
  assert.equal(result.handled, true);
  const user = await userRepo.findByEmail("a@example.com");
  assert.equal(user?.entitlementStatus, "free");
  assert.equal(user?.entitlementExpiresAt, null);
});

test("is_voided: also revokes (explicit decision -- treated the same as a refund, not a no-op)", async () => {
  const userRepo = makeInMemoryUserRepo([
    { id: "u1", email: "a@example.com", passwordHash: null, chatgptLinkedAt: null, entitlementStatus: "pro", entitlementExpiresAt: SEASON_END_DATE_PLACEHOLDER },
  ]);
  const pendingPayments = makeInMemoryPendingPayments({ order_1: "u1" });
  const result = await handlePaymobTransactionWith(userRepo, pendingPayments, {
    orderId: "order_1",
    success: true,
    pending: false,
    isRefunded: false,
    isVoided: true,
  });
  assert.equal(result.handled, true);
  assert.match(result.note, /voided/);
  const user = await userRepo.findByEmail("a@example.com");
  assert.equal(user?.entitlementStatus, "free");
});

test("refund/void for an order id with no pendingPayments record: not handled, never guesses which user", async () => {
  const userRepo = makeInMemoryUserRepo();
  const pendingPayments = makeInMemoryPendingPayments();
  const result = await handlePaymobTransactionWith(userRepo, pendingPayments, {
    orderId: "order_unknown",
    success: true,
    pending: false,
    isRefunded: true,
    isVoided: false,
  });
  assert.equal(result.handled, false);
});
