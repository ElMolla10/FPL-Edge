import { getDb, isMissingTableError } from "../../../../db";
import { getCurrentUser } from "../../../lib/auth";
import { consumeSignupAttemptAtomicWith, type RateLimitSqlExecutor } from "../../../lib/login-rate-limit-store";
import { notifyWriteKey, parseNotificationPrefsBody, readNotificationPrefs, writeNotifyOptIn, type PrefsDb } from "../../../lib/notification-prefs";
import { bodyErrorResponse, readJsonBody, rejectCrossSite } from "../../../lib/request-guards";

const NO_STORE = { "Cache-Control": "no-store" };
const SCHEMA_MISSING = "The database schema isn't set up yet. Apply the migration (see README.md) and try again.";

async function rawDb(): Promise<PrefsDb> {
  const { env } = await import("cloudflare:workers");
  return env.DB as unknown as PrefsDb;
}

/** Session cookie only (#80). Returns the address mail would go to so the UI can show it. */
export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Not signed in." }, { status: 401, headers: NO_STORE });
    const prefs = await readNotificationPrefs(await rawDb(), user.id);
    return Response.json({ ...prefs, email: user.email }, { headers: NO_STORE });
  } catch (error) {
    console.error("notifications GET error:", error instanceof Error ? error.name : "error");
    if (isMissingTableError(error)) return Response.json({ error: SCHEMA_MISSING }, { status: 503, headers: NO_STORE });
    return Response.json({ error: "Could not load notification settings." }, { status: 500, headers: NO_STORE });
  }
}

export async function PUT(request: Request) {
  // Order matters: CSRF -> session -> body validation -> rate limit -> write.
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Not signed in." }, { status: 401, headers: NO_STORE });

    let body;
    try {
      body = parseNotificationPrefsBody(await readJsonBody(request));
    } catch (error) {
      const response = bodyErrorResponse(error);
      if (response) return response;
      throw error;
    }

    const db = await getDb();
    const limit = await consumeSignupAttemptAtomicWith(db as unknown as RateLimitSqlExecutor, notifyWriteKey(user.id));
    if (!limit.ok) {
      return Response.json({ error: "Too many changes. Try again later." }, { status: 429, headers: { ...NO_STORE, "Retry-After": String(limit.retryAfterSeconds) } });
    }

    const raw = await rawDb();
    await writeNotifyOptIn(raw, user.id, body.notifyCallChanges, new Date().toISOString());
    const prefs = await readNotificationPrefs(raw, user.id);
    return Response.json({ ...prefs, email: user.email }, { headers: NO_STORE });
  } catch (error) {
    console.error("notifications PUT error:", error instanceof Error ? error.name : "error");
    if (isMissingTableError(error)) return Response.json({ error: SCHEMA_MISSING }, { status: 503, headers: NO_STORE });
    return Response.json({ error: "Could not save notification settings." }, { status: 500, headers: NO_STORE });
  }
}
