import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthError,
  UserRecord,
  UserRepo,
  hashPassword,
  resolveChatGptUserWith,
  signInWithPasswordWith,
  signUpWithPasswordWith,
  verifyPassword,
} from "../app/lib/auth-core.ts";

function makeInMemoryRepo(seed: UserRecord[] = []): UserRepo {
  const rows = new Map<string, UserRecord>(seed.map((u) => [u.id, { ...u }]));
  return {
    async findByEmail(email) {
      for (const row of rows.values()) if (row.email === email) return { ...row };
      return null;
    },
    async insert(user) {
      rows.set(user.id, { ...user });
    },
    async update(id, patch) {
      const existing = rows.get(id);
      if (existing) rows.set(id, { ...existing, ...patch });
    },
  };
}

test("password hashing: verifyPassword accepts the correct password and rejects a wrong one", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyPassword("wrong password", hash), false);
});

test("password hashing: two hashes of the same password are different (random salt) but both verify", async () => {
  const hashA = await hashPassword("same-password");
  const hashB = await hashPassword("same-password");
  assert.notEqual(hashA, hashB);
  assert.equal(await verifyPassword("same-password", hashA), true);
  assert.equal(await verifyPassword("same-password", hashB), true);
});

test("signUpWithPasswordWith: creates a new user for an unseen email", async () => {
  const repo = makeInMemoryRepo();
  const user = await signUpWithPasswordWith(repo, "New@Example.com", "somepassword");
  assert.equal(user.email, "new@example.com"); // normalized
  assert.ok(user.passwordHash);
  assert.equal(user.chatgptLinkedAt, null);
});

test("signUpWithPasswordWith: rejects a duplicate email (plain, not yet ChatGPT-linked)", async () => {
  const repo = makeInMemoryRepo([{ id: "1", email: "taken@example.com", passwordHash: "x", chatgptLinkedAt: null }]);
  await assert.rejects(() => signUpWithPasswordWith(repo, "taken@example.com", "somepassword"), AuthError);
});

test("security fix: signUpWithPasswordWith rejects an email that's already ChatGPT-linked -- cannot attach an unverified password to a verified identity", async () => {
  const repo = makeInMemoryRepo([{ id: "1", email: "verified@example.com", passwordHash: null, chatgptLinkedAt: "2026-01-01T00:00:00.000Z" }]);
  await assert.rejects(() => signUpWithPasswordWith(repo, "verified@example.com", "attackerpassword"), AuthError);
});

test("security fix: resolveChatGptUserWith nulls out an existing password_hash when linking a password-only row, not just stamping chatgptLinkedAt", async () => {
  // Reproduces the front-run scenario: an attacker registered a password on the victim's email
  // before the victim ever used ChatGPT sign-in.
  const repo = makeInMemoryRepo([{ id: "1", email: "victim@example.com", passwordHash: await hashPassword("attacker-password"), chatgptLinkedAt: null }]);

  const linked = await resolveChatGptUserWith(repo, "victim@example.com");
  assert.equal(linked.id, "1", "must resolve to the SAME account, not create a second one");
  assert.ok(linked.chatgptLinkedAt, "chatgptLinkedAt must be stamped");
  assert.equal(linked.passwordHash, null, "the pre-existing password hash must be nulled out on link");

  // The attacker's password must no longer work against this now-linked account.
  await assert.rejects(() => signInWithPasswordWith(repo, "victim@example.com", "attacker-password"), AuthError);

  // Persisted, not just returned -- a fresh read from the repo must reflect the same state.
  const reread = await repo.findByEmail("victim@example.com");
  assert.equal(reread?.passwordHash, null);
  assert.ok(reread?.chatgptLinkedAt);
});

test("resolveChatGptUserWith: repeat sign-in for an already-linked row resolves to the same account and does not re-touch it", async () => {
  const repo = makeInMemoryRepo([{ id: "1", email: "user@example.com", passwordHash: null, chatgptLinkedAt: "2026-01-01T00:00:00.000Z" }]);
  const resolved = await resolveChatGptUserWith(repo, "user@example.com");
  assert.equal(resolved.id, "1");
  assert.equal(resolved.chatgptLinkedAt, "2026-01-01T00:00:00.000Z", "an already-linked row's timestamp should not change on repeat sign-in");
});

test("resolveChatGptUserWith: creates a new user for an email never seen before", async () => {
  const repo = makeInMemoryRepo();
  const user = await resolveChatGptUserWith(repo, "Fresh@Example.com");
  assert.equal(user.email, "fresh@example.com");
  assert.equal(user.passwordHash, null);
  assert.ok(user.chatgptLinkedAt);
});

test("signInWithPasswordWith: rejects wrong password and rejects a ChatGPT-only account (no password set)", async () => {
  const repo = makeInMemoryRepo([
    { id: "1", email: "has-password@example.com", passwordHash: await hashPassword("realpassword"), chatgptLinkedAt: null },
    { id: "2", email: "chatgpt-only@example.com", passwordHash: null, chatgptLinkedAt: "2026-01-01T00:00:00.000Z" },
  ]);
  await assert.rejects(() => signInWithPasswordWith(repo, "has-password@example.com", "wrongpassword"), AuthError);
  await assert.rejects(() => signInWithPasswordWith(repo, "chatgpt-only@example.com", "anything"), AuthError);
  const ok = await signInWithPasswordWith(repo, "has-password@example.com", "realpassword");
  assert.equal(ok.id, "1");
});
