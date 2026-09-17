// Pure entitlement logic -- no Paymob/D1 imports, so it's unit-testable in plain Node (see
// tests/entitlement.test.mts). Mirrors app/lib/auth-core.ts's split: the security/business
// logic lives here against a small repo interface; app/api/billing/* wires it to real D1/Paymob.

import type { UserRecord, UserRepo } from "../auth-core";

// PLACEHOLDER -- not a confirmed real date. This app sells one seasonal payment (not a
// recurring subscription), so a granted entitlement needs a real season-end cutoff. Mohamed
// has not yet confirmed the actual 2025/26 Premier League season end date, and Rule #4 (never
// invent a number/fact) means this must not be silently treated as real. Using a clearly-named
// placeholder so the grant/checkout flow has a concrete value to run against mocks -- this MUST
// be confirmed and replaced (or made configurable) before any real payment is taken.
export const SEASON_END_DATE_PLACEHOLDER = "2026-05-31T23:59:59.000Z";

// The single check every Pro-gated surface (route, page, or API) should call.
export function hasProAccess(user: UserRecord | null | undefined): boolean {
  if (!user) return false;
  if (user.isOwner) return true;
  if (user.entitlementStatus !== "pro") return false;
  if (!user.entitlementExpiresAt) return false;
  return new Date(user.entitlementExpiresAt).getTime() > Date.now();
}

export async function grantProEntitlementWith(repo: UserRepo, userId: string, expiresAt: string): Promise<void> {
  await repo.update(userId, { entitlementStatus: "pro", entitlementExpiresAt: expiresAt } satisfies Partial<Omit<UserRecord, "id">>);
}

// Reverts to 'free' rather than deleting anything -- a refund/void ends access immediately, it
// doesn't undo the fact that a purchase was attempted (the pendingPayments row stays, see
// app/lib/billing/pending-payments.ts, since a later refund/void callback for the same order still
// needs it to resolve back to this user).
export async function revokeProEntitlementWith(repo: UserRepo, userId: string): Promise<void> {
  await repo.update(userId, { entitlementStatus: "free", entitlementExpiresAt: null });
}
