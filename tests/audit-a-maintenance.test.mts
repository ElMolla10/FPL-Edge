import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pruneExpiredData, type D1Like } from "../app/lib/maintenance.ts";
import { LOGIN_RATE_LIMIT, SIGNUP_RATE_LIMIT } from "../app/lib/login-rate-limit.ts";
import { readFileSync } from "node:fs";

// Minimal D1 facade over node:sqlite: prepare(sql).bind(...).run() -> { meta: { changes } }.
function fakeD1(): { sqlite: DatabaseSync; d1: D1Like } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users (id text PRIMARY KEY, email text NOT NULL UNIQUE);
    CREATE TABLE sessions (id text PRIMARY KEY NOT NULL, user_id text NOT NULL, created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL, expires_at text NOT NULL);
    CREATE TABLE login_rate_limits (key text PRIMARY KEY NOT NULL, kind text NOT NULL, fail_count integer NOT NULL DEFAULT 0, window_started_at text NOT NULL, blocked_until text, updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP);
  `);
  const d1: D1Like = {
    prepare(query) {
      return {
        bind(...values) {
          return {
            async run() {
              const info = sqlite.prepare(query).run(...(values as never[]));
              return { meta: { changes: Number(info.changes) } };
            },
          };
        },
      };
    },
  };
  return { sqlite, d1 };
}

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const H = 3_600_000;

test("pruneExpiredData deletes only expired sessions", async () => {
  const { sqlite, d1 } = fakeD1();
  const ins = sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, 'u', ?)");
  ins.run("expired-long-ago", iso(-90 * 24 * H));
  ins.run("expired-1s-ago", iso(-1000));
  ins.run("valid-now+1s", iso(1000));
  ins.run("valid-30d", iso(30 * 24 * H));
  const result = await pruneExpiredData(d1, NOW);
  assert.equal(result.sessionsDeleted, 2);
  const left = (sqlite.prepare("SELECT id FROM sessions ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
  assert.deepEqual(left, ["valid-30d", "valid-now+1s"]);
});

test("pruneExpiredData prunes stale rate-limit rows but keeps active windows and blocked rows", async () => {
  const { sqlite, d1 } = fakeD1();
  const ins = sqlite.prepare("INSERT INTO login_rate_limits (key, kind, fail_count, window_started_at, blocked_until) VALUES (?, ?, ?, ?, ?)");
  // stale: window long over, never blocked
  ins.run("email:old@example.com", "email", 2, iso(-3 * H), null);
  // stale: cleared by successful login (epoch)
  ins.run("ip:1.1.1.1", "ip", 0, new Date(0).toISOString(), null);
  // stale: window over and block already expired
  ins.run("email:blocked-past@example.com", "email", 5, iso(-5 * H), iso(-4 * H));
  // stale signup row, window (1h) elapsed
  ins.run("signup:ip:9.9.9.9", "ip", 4, iso(-SIGNUP_RATE_LIMIT.windowMs - 60_000), null);
  // KEEP: login window would be over (15m) but signup window (1h) is still counting for this row
  ins.run("signup:ip:8.8.8.8", "ip", 9, iso(-30 * 60_000), null);
  // KEEP: active login window
  ins.run("email:active@example.com", "email", 3, iso(-LOGIN_RATE_LIMIT.windowMs / 3), null);
  // KEEP: old window but still blocked
  ins.run("email:still-blocked@example.com", "email", 5, iso(-2 * H), iso(20 * 60_000));
  const result = await pruneExpiredData(d1, NOW);
  assert.equal(result.rateLimitsDeleted, 4);
  const left = (sqlite.prepare("SELECT key FROM login_rate_limits ORDER BY key").all() as Array<{ key: string }>).map((r) => r.key);
  assert.deepEqual(left, ["email:active@example.com", "email:still-blocked@example.com", "signup:ip:8.8.8.8"]);
});

test("pruneExpiredData still prunes sessions when login_rate_limits table is missing (migration lag)", async () => {
  const { sqlite, d1 } = fakeD1();
  sqlite.exec("DROP TABLE login_rate_limits");
  sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES ('old', 'u', ?)").run(iso(-H));
  const result = await pruneExpiredData(d1, NOW);
  assert.deepEqual(result, { sessionsDeleted: 1, rateLimitsDeleted: 0 });
});

test("pruneExpiredData is idempotent", async () => {
  const { sqlite, d1 } = fakeD1();
  sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES ('old', 'u', ?)").run(iso(-H));
  await pruneExpiredData(d1, NOW);
  assert.deepEqual(await pruneExpiredData(d1, NOW), { sessionsDeleted: 0, rateLimitsDeleted: 0 });
});

test("worker scheduled() keeps the FPL keep-alive AND runs the prune, in independent waitUntil jobs", () => {
  const src = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  const scheduled = src.slice(src.indexOf("async scheduled("));
  assert.match(scheduled, /keepAlivePersonalFplAuth\(env\)/);
  assert.match(scheduled, /pruneExpiredData\(env\.DB\)/);
  assert.equal((scheduled.match(/ctx\.waitUntil\(/g) ?? []).length, 2);
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(wrangler, /"crons"\s*:\s*\[\s*"0 \* \* \* \*"\s*\]/);
});

test("migration 0010 is idempotent and journaled", () => {
  const sql = readFileSync(new URL("../drizzle/0010_prune_indexes.sql", import.meta.url), "utf8");
  assert.equal((sql.match(/CREATE INDEX IF NOT EXISTS/g) ?? []).length, 2);
  const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  assert.equal(journal.entries.at(-1).tag, "0010_prune_indexes");
  const { sqlite } = fakeD1();
  sqlite.exec(sql);
  sqlite.exec(sql); // second run must not throw
});
