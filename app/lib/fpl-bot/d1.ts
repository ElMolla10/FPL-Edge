import type { BotDb } from "./store";

/** Raw D1 binding for the bot routes (dynamic import: plain Node / tests never resolve cloudflare:workers). */
export async function botDb(): Promise<BotDb> {
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("D1 binding DB unavailable");
  return env.DB as unknown as BotDb;
}
