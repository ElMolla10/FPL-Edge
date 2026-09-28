import { eq } from "drizzle-orm";
import { getDb, isMissingTableError } from "../../db";
import { loginRateLimits } from "../../db/schema";
import {
  RateLimitBucket,
  clearLoginRateLimitBucket,
  evaluateLoginRateLimit,
  rateLimitKeys,
  registerLoginFailure,
  type RateLimitDecision,
} from "./login-rate-limit";

async function readBucket(key: string): Promise<RateLimitBucket | null> {
  try {
    const db = await getDb();
    const [row] = await db.select().from(loginRateLimits).where(eq(loginRateLimits.key, key)).limit(1);
    if (!row) return null;
    return {
      key: row.key,
      kind: row.kind as "email" | "ip",
      failCount: row.failCount,
      windowStartedAt: row.windowStartedAt,
      blockedUntil: row.blockedUntil,
    };
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }
}

async function writeBucket(bucket: RateLimitBucket): Promise<void> {
  try {
    const db = await getDb();
    await db
      .insert(loginRateLimits)
      .values({
        key: bucket.key,
        kind: bucket.kind,
        failCount: bucket.failCount,
        windowStartedAt: bucket.windowStartedAt,
        blockedUntil: bucket.blockedUntil,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: loginRateLimits.key,
        set: {
          kind: bucket.kind,
          failCount: bucket.failCount,
          windowStartedAt: bucket.windowStartedAt,
          blockedUntil: bucket.blockedUntil,
          updatedAt: new Date().toISOString(),
        },
      });
  } catch (error) {
    if (isMissingTableError(error)) return;
    throw error;
  }
}

export async function assertLoginAllowed(email: string, ip: string): Promise<RateLimitDecision> {
  const { emailKey, ipKey } = rateLimitKeys(email, ip);
  const [emailBucket, ipBucket] = await Promise.all([readBucket(emailKey), readBucket(ipKey)]);
  return evaluateLoginRateLimit(
    [
      ...(emailBucket ? [{ ...emailBucket, kind: "email" as const }] : []),
      ...(ipBucket ? [{ ...ipBucket, kind: "ip" as const }] : []),
    ],
  );
}

export async function recordLoginFailure(email: string, ip: string): Promise<void> {
  const { emailKey, ipKey } = rateLimitKeys(email, ip);
  const [emailBucket, ipBucket] = await Promise.all([readBucket(emailKey), readBucket(ipKey)]);
  await Promise.all([
    writeBucket(registerLoginFailure(emailBucket, emailKey, "email")),
    writeBucket(registerLoginFailure(ipBucket, ipKey, "ip")),
  ]);
}

export async function clearLoginFailures(email: string, ip: string): Promise<void> {
  const { emailKey, ipKey } = rateLimitKeys(email, ip);
  await Promise.all([
    writeBucket(clearLoginRateLimitBucket(emailKey, "email")),
    writeBucket(clearLoginRateLimitBucket(ipKey, "ip")),
  ]);
}
