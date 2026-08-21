import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { sessions, users } from "../../db/schema";
import { getChatGPTUser } from "../chatgpt-auth";
import {
  UserRecord,
  UserRepo,
  resolveChatGptUserWith,
  signInWithPasswordWith,
  signUpWithPasswordWith,
  toBase64Url,
} from "./auth-core";

export { AuthError, hashPassword, verifyPassword } from "./auth-core";
export type { UserRecord, UserRepo } from "./auth-core";

export function makeD1UserRepo(): UserRepo {
  const db = getDb();
  return {
    async findByEmail(email) {
      const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      return row ?? null;
    },
    async insert(user) {
      await db.insert(users).values(user);
    },
    async update(id, patch) {
      await db.update(users).set(patch).where(eq(users.id, id));
    },
  };
}

export const signUpWithPassword = (email: string, password: string) => signUpWithPasswordWith(makeD1UserRepo(), email, password);
export const signInWithPassword = (email: string, password: string) => signInWithPasswordWith(makeD1UserRepo(), email, password);
export const resolveChatGptUser = (chatgptEmail: string) => resolveChatGptUserWith(makeD1UserRepo(), chatgptEmail);

// --- Sessions: D1-backed (not stateless), so sign-out is an immediate, real revocation. ---

export const SESSION_COOKIE = "fpl_edge_session";
const SESSION_DAYS = 30;

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const db = getDb();
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000);
  await db.insert(sessions).values({ id: token, userId, expiresAt: expiresAt.toISOString() });
  return { token, expiresAt };
}

export async function getUserBySessionToken(token: string): Promise<UserRecord | null> {
  const db = getDb();
  const [session] = await db.select().from(sessions).where(eq(sessions.id, token)).limit(1);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, token));
    return null;
  }
  const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  return user ?? null;
}

export async function deleteSessionByToken(token: string): Promise<void> {
  const db = getDb();
  await db.delete(sessions).where(eq(sessions.id, token));
}

export function serializeSessionCookie(token: string, expiresAt: Date): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expiresAt.toUTCString()}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export async function readSessionCookie(): Promise<string | null> {
  const requestHeaders = await headers();
  const cookieHeader = requestHeaders.get("cookie");
  if (!cookieHeader) return null;
  const match = cookieHeader.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${SESSION_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)) : null;
}

// Single entry point every protected route uses: checks our own session cookie first
// (password-authenticated users), then falls back to the platform-verified ChatGPT header.
// Both paths resolve through the same users.id via resolveChatGptUser's linking rules.
export async function getCurrentUser(): Promise<UserRecord | null> {
  const token = await readSessionCookie();
  if (token) {
    const user = await getUserBySessionToken(token);
    if (user) return user;
  }
  const chatgptUser = await getChatGPTUser();
  if (chatgptUser) return resolveChatGptUser(chatgptUser.email);
  return null;
}
