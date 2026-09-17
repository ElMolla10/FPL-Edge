import assert from "node:assert/strict";
import test from "node:test";
import { hasProAccess } from "../app/lib/billing/entitlement.ts";
import type { UserRecord } from "../app/lib/auth-core.ts";

const base: UserRecord = { id: "1", email: "user@example.com", passwordHash: null, chatgptLinkedAt: null };

test("hasProAccess: false for a signed-out user (null)", () => {
  assert.equal(hasProAccess(null), false);
});

test("hasProAccess: false for a plain free-tier user", () => {
  assert.equal(hasProAccess({ ...base, entitlementStatus: "free" }), false);
});

test("hasProAccess: true for a pro user whose entitlement hasn't expired", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal(hasProAccess({ ...base, entitlementStatus: "pro", entitlementExpiresAt: future }), true);
});

test("hasProAccess: false for a pro user whose entitlement already expired", () => {
  const past = new Date(Date.now() - 86_400_000).toISOString();
  assert.equal(hasProAccess({ ...base, entitlementStatus: "pro", entitlementExpiresAt: past }), false);
});

test("hasProAccess: false for entitlementStatus 'pro' with no expiry date set", () => {
  assert.equal(hasProAccess({ ...base, entitlementStatus: "pro", entitlementExpiresAt: null }), false);
});

test("hasProAccess: isOwner always wins, regardless of entitlementStatus or expiry", () => {
  const past = new Date(Date.now() - 86_400_000).toISOString();
  assert.equal(hasProAccess({ ...base, isOwner: true, entitlementStatus: "free" }), true);
  assert.equal(hasProAccess({ ...base, isOwner: true, entitlementStatus: "pro", entitlementExpiresAt: past }), true);
});
