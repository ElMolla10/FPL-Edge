import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { BotDb } from "../../app/lib/fpl-bot/store.ts";

/** D1 facade over node:sqlite with the real bot migration applied (run / first / all). */
export function botD1(): { sqlite: DatabaseSync; db: BotDb } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../../drizzle/0012_fpl_bot.sql", import.meta.url), "utf8").replace(/--> statement-breakpoint/g, ""));
  const db: BotDb = {
    prepare(query) {
      return {
        bind(...values) {
          const args = values.map((v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v)) as never[];
          return {
            async run() {
              const info = sqlite.prepare(query).run(...args);
              return { meta: { changes: Number(info.changes) } };
            },
            async first<T>() {
              return (sqlite.prepare(query).get(...args) as T | undefined) ?? null;
            },
            async all<T>() {
              return { results: sqlite.prepare(query).all(...args) as T[] };
            },
          };
        },
      };
    },
  };
  return { sqlite, db };
}
