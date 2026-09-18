import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { personalFplAuth } from "../../../db/schema";
import { PERSONAL_FPL_REFRESH_TOKEN_ENV, parseRefreshTokenInput, type PersonalTransferEnv } from "./config";

const ROW_ID = "default";

// Never log the token. D1 holds the rotating refresh token because PingOne
// issues a new one on every exchange and Workers secrets cannot be rewritten
// from the worker.

export async function loadPersonalRefreshToken(env: PersonalTransferEnv): Promise<string | null> {
  const db = await getDb();
  const [row] = await db.select().from(personalFplAuth).where(eq(personalFplAuth.id, ROW_ID)).limit(1);
  if (row?.refreshToken) return row.refreshToken;
  const seeded = env[PERSONAL_FPL_REFRESH_TOKEN_ENV];
  if (!seeded?.trim()) return null;
  const token = parseRefreshTokenInput(seeded);
  if (!token) return null;
  await persistPersonalRefreshToken(token);
  return token;
}

export async function persistPersonalRefreshToken(token: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const [existing] = await db.select().from(personalFplAuth).where(eq(personalFplAuth.id, ROW_ID)).limit(1);
  if (existing) {
    await db.update(personalFplAuth).set({ refreshToken: token, updatedAt: now }).where(eq(personalFplAuth.id, ROW_ID));
    return;
  }
  await db.insert(personalFplAuth).values({ id: ROW_ID, refreshToken: token, updatedAt: now });
}
