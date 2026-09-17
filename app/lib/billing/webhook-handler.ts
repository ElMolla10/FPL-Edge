// Pure event-handling logic, independent of the real Paymob gateway -- takes the normalized
// PaymobTransaction shape (see paymob-gateway.ts), so tests can construct fake transactions
// directly without needing a real (or mocked) HMAC-verified callback body.

import type { UserRepo } from "../auth-core";
import type { PaymobTransaction } from "./paymob-gateway";
import type { PendingPaymentsRepo } from "./pending-payments";
import { grantProEntitlementWith, revokeProEntitlementWith, SEASON_END_DATE_PLACEHOLDER } from "./entitlement";

export type WebhookHandlingResult = { handled: boolean; note: string };

// Mapping ratified in the Phase 3 design checkpoint for the one-time-seasonal-payment model, then
// re-ratified for Paymob's boolean-field callback shape (there's no discrete event-name per
// outcome the way Stripe had): a successful, non-refunded, non-voided transaction grants; a
// pending or outright-failed transaction is a no-op (nothing was ever granted for it); a refund OR
// a void revokes -- is_voided is treated the same as is_refunded (not left as a no-op) because a
// void means the charge never legitimately completed, and the standing bias throughout this
// billing system is to remove access rather than keep it on an ambiguous/reversed outcome.
export async function handlePaymobTransactionWith(
  userRepo: UserRepo,
  pendingPayments: PendingPaymentsRepo,
  transaction: PaymobTransaction
): Promise<WebhookHandlingResult> {
  if (transaction.isRefunded || transaction.isVoided) {
    const userId = await pendingPayments.findUserId(transaction.orderId);
    if (!userId) return { handled: false, note: `refund/void for unknown Paymob order ${transaction.orderId}` };
    await revokeProEntitlementWith(userRepo, userId);
    return { handled: true, note: `revoked pro from user ${userId} (${transaction.isVoided ? "voided" : "refunded"})` };
  }

  if (transaction.success && !transaction.pending) {
    const userId = await pendingPayments.findUserId(transaction.orderId);
    if (!userId) return { handled: false, note: `success for unknown Paymob order ${transaction.orderId}` };
    await grantProEntitlementWith(userRepo, userId, SEASON_END_DATE_PLACEHOLDER);
    return { handled: true, note: `granted pro to user ${userId}` };
  }

  // Pending, or an outright failed (success:false, not refunded/voided) transaction: nothing was
  // ever granted for it, so there's nothing to revoke either.
  return { handled: true, note: `no-op: success=${transaction.success} pending=${transaction.pending}` };
}
