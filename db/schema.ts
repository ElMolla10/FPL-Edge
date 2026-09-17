import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Email is the single identity anchor across both auth methods (password and ChatGPT
// sign-in) -- see app/lib/auth.ts for the resolution rules that keep this one coherent
// account per email rather than two disconnected identity systems.
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"), // null if the account has never had a password set
  chatgptLinkedAt: text("chatgpt_linked_at"), // null until a verified ChatGPT sign-in claims this row
  displayName: text("display_name"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  // Permanent override, unrelated to any payment-provider state -- see
  // app/lib/billing/entitlement.ts. A real column, not a hardcoded email check, so it survives
  // provider test-mode limitations, a billing outage, or a future refactor without being silently
  // rediscovered as a special case.
  isOwner: integer("is_owner", { mode: "boolean" }).notNull().default(false),
  // 'free' until a completed Paymob payment grants 'pro' (see the webhook handler); reverted to
  // 'free' on a refund or void. Never trust this alone without also checking entitlementExpiresAt
  // against now -- see hasProAccess.
  entitlementStatus: text("entitlement_status").notNull().default("free"),
  // Null until the first successful payment. A one-time seasonal payment, not a recurring
  // subscription -- this is a fixed end-of-season cutoff set at grant time, not something the
  // provider renews on its own. "Renewal" for next season is a fresh checkout, not an automatic
  // event.
  entitlementExpiresAt: text("entitlement_expires_at"),
});

// Maps a Paymob order id (created at checkout time) to the user who initiated it -- Paymob's
// callback carries the order id, not an arbitrary reference field we control (unlike Stripe's
// client_reference_id), so this explicit mapping is how the webhook resolves a transaction back to
// a user. Deliberately never deleted once written: a refund or void callback for the same order can
// arrive well after the original grant, and still needs this row to resolve back to a user (see
// app/lib/billing/webhook-handler.ts).
export const pendingPayments = sqliteTable("pending_payments", {
  paymobOrderId: text("paymob_order_id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(), // opaque random token, also the session cookie value
  userId: text("user_id").notNull().references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at").notNull(),
});

export const squadData = sqliteTable("squad_data", {
  userId: text("user_id").primaryKey().references(() => users.id),
  squadIds: text("squad_ids").notNull().default("[]"),
  watchlist: text("watchlist").notNull().default("[]"),
  locks: text("locks").notNull().default("[]"),
  captainVice: text("captain_vice").notNull().default("{}"), // {eventId: {captainId, viceId}}
  entry: text("entry"), // official FPL Team ID
  manager: text("manager"), // JSON ManagerMeta blob
  // JSON PersistedPlan[] (see app/lib/strategy-plans.ts) -- capped at MAX_PLANS, IDs only (player
  // ids, never full FplPlayer blobs), rehydrated against the live player pool on read, same
  // squadIds-is-IDs-only discipline as the field above.
  plans: text("plans").notNull().default("[]"),
  // JSON PlannedChip[] (see app/lib/chip-portfolio.ts) -- capped at 4, one row per chip name, the
  // single source of truth the chip-portfolio inventory, the captain picker's pre-deadline
  // multiplier preview, and the Wildcard/Free Hit planning surface all read and write.
  plannedChips: text("planned_chips").notNull().default("[]"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Singleton row (id is always "overall") -- population-wide, identical for every user, so this is
// one shared row refreshed on a TTL, not one row per user like squadData above. See
// app/lib/population-percentile-core.ts for the staleness/refresh logic that reads and writes it.
export const populationPercentiles = sqliteTable("population_percentiles", {
  id: text("id").primaryKey(),
  eventId: integer("event_id").notNull(),
  eventFinished: integer("event_finished", { mode: "boolean" }).notNull(),
  totalPlayers: integer("total_players").notNull(), // bootstrap-static's total_players at sample time
  curve: text("curve").notNull(), // JSON: {rank:number; points:number}[], ascending by rank
  omittedSamples: integer("omitted_samples").notNull(),
  sampledAt: text("sampled_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  // Most recently FINISHED event's real average_entry_score (not a season-to-date average) --
  // see population-percentile.ts's fetchCurrentEvent. Null before any gameweek has finished.
  recentAverageGameweekScore: integer("recent_average_gameweek_score"),
});
