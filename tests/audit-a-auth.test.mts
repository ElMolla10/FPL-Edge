import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import {
  MAX_LOGIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  UserRecord,
  UserRepo,
  registerAccountWith,
  signInWithPasswordWith,
  validateNewPassword,
} from "../app/lib/auth-core.ts";
import { SIGNUP_RATE_LIMIT, applyAtomicSignupIncrement, evaluateSignupAttempt, signupIpKey } from "../app/lib/login-rate-limit.ts";
import { consumeSignupAttemptAtomicWith, type RateLimitSqlExecutor } from "../app/lib/login-rate-limit-store.ts";
import { readFileSync } from "node:fs";

function makeRepo(seed: UserRecord[] = [], failInsertWith?: Error): UserRepo & { rows: UserRecord[] } {
  const rows = seed.map((u) => ({ ...u }));
  return {
    rows,
    async findByEmail(email) {
      return rows.find((r) => r.email === email) ?? null;
    },
    async insert(user) {
      if (failInsertWith) throw failInsertWith;
      rows.push({ ...user });
    },
    async update() {},
  };
}

// --- Item 1: non-oracle signup ----------------------------------------------------------------

test("registerAccountWith: new and existing email produce the same observable result shape", async () => {
  const repo = makeRepo([{ id: "1", email: "taken@example.com", passwordHash: "pbkdf2$1$x$y", chatgptLinkedAt: null }]);
  const fresh = await registerAccountWith(repo, "New@Example.com", "password123");
  const dup = await registerAccountWith(repo, "taken@example.com", "password123");
  assert.deepEqual(Object.keys(fresh), Object.keys(dup));
  assert.equal(fresh.created, true);
  assert.equal(dup.created, false);
  assert.equal(repo.rows.length, 2);
  assert.equal(repo.rows[1].email, "new@example.com");
});

test("registerAccountWith: duplicate signup never modifies the existing account (no password overwrite / takeover)", async () => {
  const original: UserRecord = { id: "1", email: "victim@example.com", passwordHash: "pbkdf2$1$salt$hash", chatgptLinkedAt: null };
  const repo = makeRepo([original]);
  await registerAccountWith(repo, "victim@example.com", "attacker-password");
  assert.deepEqual(repo.rows[0], original);
});

test("registerAccountWith: a unique-constraint race on insert is swallowed (still identical response), other errors propagate", async () => {
  const race = makeRepo([], new Error("D1_ERROR: UNIQUE constraint failed: users.email"));
  assert.deepEqual(await registerAccountWith(race, "a@b.co", "password123"), { created: false });
  const boom = makeRepo([], new Error("D1_ERROR: database is on fire"));
  await assert.rejects(() => registerAccountWith(boom, "a@b.co", "password123"), /on fire/);
});

test("registerAccountWith: duplicate path still burns a PBKDF2 hash (timing roughly equal)", async () => {
  const repo = makeRepo([{ id: "1", email: "taken@example.com", passwordHash: "x", chatgptLinkedAt: null }]);
  const time = async (email: string) => {
    const t = performance.now();
    await registerAccountWith(repo, email, "password123");
    return performance.now() - t;
  };
  await time("warm@example.com"); // warm-up
  const fresh = await time("brand-new@example.com");
  const dup = await time("taken@example.com");
  // Without the dummy hash the duplicate path would be ~0ms vs ~30-100ms for PBKDF2.
  assert.ok(dup > fresh * 0.4, `duplicate path too fast: dup=${dup.toFixed(1)}ms fresh=${fresh.toFixed(1)}ms`);
});

test("signInWithPasswordWith: unknown email also runs a hash and returns the same error as a wrong password", async () => {
  const repo = makeRepo([]);
  const t = performance.now();
  await assert.rejects(() => signInWithPasswordWith(repo, "nobody@example.com", "whatever123"), { message: "Incorrect email or password." });
  assert.ok(performance.now() - t > 3, "unknown-email path should not return instantly");
});

test("signup route: no session cookie, no 409, uses registerAccount + rate limit before hashing", () => {
  const src = readFileSync(new URL("../app/api/auth/signup/route.ts", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /status: 409/);
  assert.doesNotMatch(src, /createSession|Set-Cookie|serializeSessionCookie/);
  assert.match(src, /registerAccount\(/);
  assert.ok(src.indexOf("consumeSignupAttempt(") < src.indexOf("registerAccount("), "rate limit must run before PBKDF2");
  assert.match(src, /status: 429/);
  assert.match(src, /"Retry-After"/);
});

// --- Item 3: password length cap --------------------------------------------------------------

test("validateNewPassword enforces 8..128", () => {
  assert.match(validateNewPassword("short")!, /at least 8/);
  assert.equal(validateNewPassword("x".repeat(8)), null);
  assert.equal(validateNewPassword("x".repeat(MAX_PASSWORD_LENGTH)), null);
  assert.match(validateNewPassword("x".repeat(MAX_PASSWORD_LENGTH + 1))!, /at most 128/);
});

test("login accepts legacy long passwords (> signup cap) but bounds absurd ones", () => {
  assert.ok(MAX_LOGIN_PASSWORD_LENGTH > MAX_PASSWORD_LENGTH);
  const src = readFileSync(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8");
  assert.match(src, /MAX_LOGIN_PASSWORD_LENGTH/);
});

// --- Item 2: signup rate limit ----------------------------------------------------------------

test("signup key namespace is separate from login email/ip keys", () => {
  assert.equal(signupIpKey("1.2.3.4"), "signup:ip:1.2.3.4");
  assert.notEqual(signupIpKey("1.2.3.4"), "ip:1.2.3.4");
});

test("applyAtomicSignupIncrement + evaluateSignupAttempt: allows maxAttempts, blocks the next, window reset unblocks", () => {
  const t0 = Date.parse("2026-09-30T10:00:00.000Z");
  let state: { failCount: number; windowStartedAt: string } | null = null;
  for (let i = 1; i <= SIGNUP_RATE_LIMIT.maxAttempts; i++) {
    state = applyAtomicSignupIncrement(state, t0 + i);
    assert.equal(evaluateSignupAttempt(state, t0 + i).ok, true, `attempt ${i}`);
  }
  state = applyAtomicSignupIncrement(state, t0 + 100);
  const blocked = evaluateSignupAttempt(state, t0 + 100);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.ok(blocked.retryAfterSeconds > 3000 && blocked.retryAfterSeconds <= 3600);
  state = applyAtomicSignupIncrement(state, t0 + SIGNUP_RATE_LIMIT.windowMs + 1000);
  assert.equal(state.failCount, 1);
  assert.equal(evaluateSignupAttempt(state, t0 + SIGNUP_RATE_LIMIT.windowMs + 1000).ok, true);
});

function makeSqliteExecutor(): { db: DatabaseSync; exec: RateLimitSqlExecutor } {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE login_rate_limits (key text PRIMARY KEY NOT NULL, kind text NOT NULL, fail_count integer NOT NULL DEFAULT 0, window_started_at text NOT NULL, blocked_until text, updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  const dialect = new SQLiteSyncDialect();
  return {
    db,
    exec: {
      async all(query) {
        const { sql, params } = dialect.sqlToQuery(query);
        return db.prepare(sql).all(...(params as never[])) as unknown[];
      },
    },
  };
}

test("consumeSignupAttemptAtomicWith (real SQLite): one-statement upsert counts 1..N, blocks after max, resets after window", async () => {
  const { db, exec } = makeSqliteExecutor();
  const key = signupIpKey("203.0.113.9");
  const t0 = Date.parse("2026-09-30T10:00:00.000Z");
  for (let i = 1; i <= SIGNUP_RATE_LIMIT.maxAttempts; i++) {
    assert.equal((await consumeSignupAttemptAtomicWith(exec, key, t0 + i)).ok, true, `attempt ${i}`);
  }
  const over = await consumeSignupAttemptAtomicWith(exec, key, t0 + 50);
  assert.equal(over.ok, false);
  if (!over.ok) assert.ok(over.retryAfterSeconds > 3500);
  const row = db.prepare("SELECT kind, fail_count, blocked_until FROM login_rate_limits WHERE key = ?").get(key) as { kind: string; fail_count: number; blocked_until: string | null };
  assert.equal(row.kind, "ip");
  assert.equal(row.fail_count, SIGNUP_RATE_LIMIT.maxAttempts + 1);
  assert.ok(row.blocked_until, "blocked_until recorded once over the limit");
  // different IP unaffected
  assert.equal((await consumeSignupAttemptAtomicWith(exec, signupIpKey("198.51.100.1"), t0 + 60)).ok, true);
  // after the window: reset
  assert.equal((await consumeSignupAttemptAtomicWith(exec, key, t0 + SIGNUP_RATE_LIMIT.windowMs + 5000)).ok, true);
});

test("consumeSignupAttemptAtomicWith: parallel attempts cannot slip under the limit", async () => {
  const { exec } = makeSqliteExecutor();
  const key = signupIpKey("192.0.2.7");
  const t0 = Date.parse("2026-09-30T10:00:00.000Z");
  const results = await Promise.all(Array.from({ length: 25 }, () => consumeSignupAttemptAtomicWith(exec, key, t0)));
  assert.equal(results.filter((r) => r.ok).length, SIGNUP_RATE_LIMIT.maxAttempts);
  assert.equal(results.filter((r) => !r.ok).length, 25 - SIGNUP_RATE_LIMIT.maxAttempts);
});

test("signup limiter uses a single atomic statement (no read-modify-write) and does not touch login helpers", () => {
  const src = readFileSync(new URL("../app/lib/login-rate-limit-store.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export async function consumeSignupAttemptAtomicWith"), src.indexOf("export async function consumeSignupAttempt("));
  assert.match(body, /ON CONFLICT\(key\) DO UPDATE SET/);
  assert.match(body, /RETURNING fail_count/);
  assert.doesNotMatch(body, /readBucket|writeBucket/);
});
