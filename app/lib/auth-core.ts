// Pure identity-resolution and password logic -- no Cloudflare/D1/Next.js imports, so this file
// can be unit-tested directly in plain Node (see tests/auth.test.mts). All D1-bound wiring
// (sessions, cookies, getCurrentUser) lives in app/lib/auth.ts, which wraps these functions.

export class AuthError extends Error {}

export type UserRecord = { id: string; email: string; passwordHash: string | null; chatgptLinkedAt: string | null };

// Small repository interface so the identity-resolution logic below (the security-critical
// part) is unit-testable against an in-memory fake, independent of a real D1 binding.
export type UserRepo = {
  findByEmail(email: string): Promise<UserRecord | null>;
  insert(user: UserRecord): Promise<void>;
  update(id: string, patch: Partial<Omit<UserRecord, "id">>): Promise<void>;
};

const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Longest password accepted when SETTING one (signup). PBKDF2 cost does not depend on length, but an unbounded value is free request-size abuse. */
export const MAX_PASSWORD_LENGTH = 128;
export const MIN_PASSWORD_LENGTH = 8;
/**
 * Longest password accepted when CHECKING one (login). Deliberately looser than MAX_PASSWORD_LENGTH:
 * signup had no cap before, so an existing account may carry a >128-char password and must keep
 * signing in. This bound only exists to reject absurd payloads.
 */
export const MAX_LOGIN_PASSWORD_LENGTH = 1024;
export const MAX_EMAIL_LENGTH = 254;

/** Returns a user-facing error for an unacceptable NEW password, or null when fine. */
export function validateNewPassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  return null;
}

export async function signUpWithPasswordWith(repo: UserRepo, email: string, password: string): Promise<UserRecord> {
  const normalizedEmail = normalizeEmail(email);
  const existing = await repo.findByEmail(normalizedEmail);
  if (existing) {
    if (existing.chatgptLinkedAt) {
      throw new AuthError("An account already exists for this email. Sign in instead, or use a different email.");
    }
    throw new AuthError("An account already exists for this email. Sign in instead.");
  }
  const passwordHash = await hashPassword(password);
  const user: UserRecord = { id: crypto.randomUUID(), email: normalizedEmail, passwordHash, chatgptLinkedAt: null };
  await repo.insert(user);
  return user;
}

/**
 * Non-oracle signup: identical outcome whether or not the email is already registered.
 * - New email: creates the account (caller must NOT start a session -- that would be an oracle).
 * - Existing email (or a concurrent insert racing us on the unique index): no-op.
 * The duplicate path still burns one PBKDF2 hash so response time is roughly equal.
 * `created` is for tests/logging only and must never reach the HTTP response.
 */
export async function registerAccountWith(repo: UserRepo, email: string, password: string): Promise<{ created: boolean }> {
  const normalizedEmail = normalizeEmail(email);
  const existing = await repo.findByEmail(normalizedEmail);
  const passwordHash = await hashPassword(password);
  if (existing) return { created: false };
  const user: UserRecord = { id: crypto.randomUUID(), email: normalizedEmail, passwordHash, chatgptLinkedAt: null };
  try {
    await repo.insert(user);
  } catch (error) {
    if (isUniqueConstraintError(error)) return { created: false };
    throw error;
  }
  return { created: true };
}

export function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(`${message} ${cause}`);
}

let dummyHashPromise: Promise<string> | null = null;

export async function signInWithPasswordWith(repo: UserRepo, email: string, password: string): Promise<UserRecord> {
  const user = await repo.findByEmail(normalizeEmail(email));
  if (!user || !user.passwordHash) {
    // Equalise timing with the real-user path so response time does not reveal whether the email exists.
    dummyHashPromise ??= hashPassword("timing-equaliser-not-a-real-password");
    await verifyPassword(password, await dummyHashPromise);
    throw new AuthError("Incorrect email or password.");
  }
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) throw new AuthError("Incorrect email or password.");
  return user;
}

// LEGACY (unused by HTTP auth): previously linked accounts via spoofable oai-* headers on
// Workers. Kept only for unit tests of the historical linking rules. Do not call from
// request handlers — getCurrentUser() is session-cookie only.
export async function resolveChatGptUserWith(repo: UserRepo, chatgptEmail: string): Promise<UserRecord> {
  const normalizedEmail = normalizeEmail(chatgptEmail);
  const existing = await repo.findByEmail(normalizedEmail);
  if (existing) {
    if (existing.chatgptLinkedAt) return existing;
    // Linking an existing password-only row to a verified ChatGPT identity. Null out the
    // password hash: a front-run/pre-registered password on this email must not continue to
    // grant access once the real (ChatGPT-verified) owner claims the row -- otherwise whoever
    // set that password keeps a standing credential into an account that now holds the real
    // owner's data. Safe to do automatically only because the incoming signal (the ChatGPT
    // header) is platform-verified; only the real email owner can ever trigger this path.
    const chatgptLinkedAt = new Date().toISOString();
    await repo.update(existing.id, { chatgptLinkedAt, passwordHash: null });
    return { ...existing, chatgptLinkedAt, passwordHash: null };
  }
  const user: UserRecord = { id: crypto.randomUUID(), email: normalizedEmail, passwordHash: null, chatgptLinkedAt: new Date().toISOString() };
  await repo.insert(user);
  return user;
}

// --- Password hashing: PBKDF2-HMAC-SHA256 via the native Web Crypto API. No new dependency,
// works identically in the Workers runtime and any Node runtime. Iteration count follows
// OWASP's 2023 guidance for PBKDF2-SHA256. Format is self-describing (pbkdf2$iterations$salt$hash)
// so the iteration count can be raised later without invalidating existing hashes. ---

// Workers Web Crypto rejects anything above 100,000
// ("iteration counts above 100000 are not supported"). The hash stores the
// count, so an older hash still verifies at whatever count it was created with.
const PBKDF2_ITERATIONS = 100_000;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padLength = (4 - (value.length % 4)) % 4;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLength);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" }, keyMaterial, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(derived)}`;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  const salt = fromBase64Url(parts[2]);
  const derived = await deriveBits(password, salt, iterations);
  return timingSafeEqual(toBase64Url(derived), parts[3]);
}

// Exported for app/lib/auth.ts's session-token generation (same encoding as password salts/hashes).
export { toBase64Url };
