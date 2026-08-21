import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
