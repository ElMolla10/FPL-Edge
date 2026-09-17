import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { pendingPayments } from "../../../db/schema";

// Maps a Paymob order id back to the user who initiated it. Written at checkout time (before we
// know how the payment will resolve), read when the server-to-server callback arrives. Necessary
// because Paymob's callback carries its own order id, not an arbitrary reference field we control
// the way Stripe's client_reference_id worked -- see db/schema.ts's pendingPayments table.
export type PendingPaymentsRepo = {
  record(paymobOrderId: string, userId: string): Promise<void>;
  findUserId(paymobOrderId: string): Promise<string | null>;
};

export function makeD1PendingPaymentsRepo(): PendingPaymentsRepo {
  return {
    async record(paymobOrderId, userId) {
      const db = await getDb();
      await db.insert(pendingPayments).values({ paymobOrderId, userId });
    },
    async findUserId(paymobOrderId) {
      const db = await getDb();
      const [row] = await db.select().from(pendingPayments).where(eq(pendingPayments.paymobOrderId, paymobOrderId)).limit(1);
      return row?.userId ?? null;
    },
  };
}
