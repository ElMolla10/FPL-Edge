import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { seasonCheckouts, seasonPasses } from "../../db/schema";
import {
  CheckoutRecord,
  SeasonGrantRepo,
  SeasonPassRecord,
  isSeasonPassActive,
} from "./season-pass";

export type SeasonPassSummary = { active: boolean; endsAt: string | null; seasonKey: string | null };

function toPass(row: { userId: string; seasonKey: string; startsAt: string; endsAt: string }): SeasonPassRecord {
  return { userId: row.userId, seasonKey: row.seasonKey, startsAt: row.startsAt, endsAt: row.endsAt, status: "active" };
}

function toCheckout(row: typeof seasonCheckouts.$inferSelect): CheckoutRecord {
  const status = row.status === "paid" ? "paid" : "pending";
  return {
    id: row.id,
    userId: row.userId,
    seasonKey: row.seasonKey,
    endsAt: row.endsAt,
    amountPiasters: row.amountPiasters,
    currency: row.currency,
    status,
    paymobOrderId: row.paymobOrderId,
  };
}

export async function seasonPassSummaryForUser(userId: string, now = new Date()): Promise<SeasonPassSummary> {
  const db = await getDb();
  const rows = await db.select().from(seasonPasses).where(eq(seasonPasses.userId, userId));
  const covering = rows
    .map(toPass)
    .filter((pass) => isSeasonPassActive(pass, now))
    .sort((a, b) => Date.parse(b.endsAt) - Date.parse(a.endsAt));
  const active = covering[0];
  if (!active) return { active: false, endsAt: null, seasonKey: null };
  return { active: true, endsAt: active.endsAt, seasonKey: active.seasonKey };
}

export async function insertPendingCheckout(input: { id: string; userId: string; seasonKey: string; endsAt: string; amountPiasters: number }): Promise<void> {
  const db = await getDb();
  await db.insert(seasonCheckouts).values({
    id: input.id,
    userId: input.userId,
    seasonKey: input.seasonKey,
    endsAt: input.endsAt,
    amountPiasters: input.amountPiasters,
    currency: "EGP",
    status: "pending",
  });
}

export async function attachPaymobOrder(checkoutId: string, intentionId: string, orderId: string): Promise<void> {
  const db = await getDb();
  await db.update(seasonCheckouts).set({ paymobIntentionId: intentionId, paymobOrderId: orderId }).where(eq(seasonCheckouts.id, checkoutId));
}

export async function insertSeasonPass(input: { id: string; userId: string; seasonKey: string; startsAt: string; endsAt: string; amountPiasters: number; source: "paymob" | "dev-grant"; paymobTransactionId: string | null }): Promise<void> {
  const db = await getDb();
  await db.insert(seasonPasses).values({
    id: input.id,
    userId: input.userId,
    seasonKey: input.seasonKey,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    amountPiasters: input.amountPiasters,
    currency: "EGP",
    source: input.source,
    paymobTransactionId: input.paymobTransactionId,
  });
}

export function makeD1SeasonGrantRepo(): SeasonGrantRepo {
  return {
    async findCheckoutByPaymobOrderId(orderId) {
      const db = await getDb();
      const [row] = await db.select().from(seasonCheckouts).where(eq(seasonCheckouts.paymobOrderId, orderId)).limit(1);
      return row ? toCheckout(row) : null;
    },
    async findPassByTransactionId(transactionId) {
      const db = await getDb();
      const [row] = await db.select({ id: seasonPasses.id }).from(seasonPasses).where(eq(seasonPasses.paymobTransactionId, transactionId)).limit(1);
      return row ?? null;
    },
    async findCoveringPass(userId, now) {
      const db = await getDb();
      const rows = await db.select().from(seasonPasses).where(eq(seasonPasses.userId, userId));
      return rows.map(toPass).find((pass) => isSeasonPassActive(pass, now)) ?? null;
    },
    async markCheckoutPaid(checkoutId, paidAt) {
      const db = await getDb();
      await db.update(seasonCheckouts).set({ status: "paid", paidAt }).where(eq(seasonCheckouts.id, checkoutId));
    },
    async savePass(pass) {
      await insertSeasonPass(pass);
    },
  };
}
