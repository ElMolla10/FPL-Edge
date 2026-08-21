import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(env.DB, { schema });
}

// D1 doesn't auto-apply migrations (locally or in production -- see README.md). A raw
// "no such table" error surfacing as a generic 500 is confusing and has bitten this project
// twice; routes should check this and return an actionable message instead.
export function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  return `${message} ${cause}`.includes("no such table");
}
