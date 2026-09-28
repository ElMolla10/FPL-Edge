import { isMissingTableError } from "../../../../db";
import { AuthError, createSession, serializeSessionCookie, signInWithPassword } from "../../../lib/auth";
import { clientIpFromRequest } from "../../../lib/login-rate-limit";
import { assertLoginAllowed, clearLoginFailures, recordLoginFailure } from "../../../lib/login-rate-limit-store";

// Per-account + per-IP rate limits on password sign-in (D1 table login_rate_limits).
// Migration: drizzle/0009_login_rate_limit.sql — uses existing DB binding; no new secrets.
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { email?: string; password?: string };
    const email = body.email?.trim() ?? "";
    const password = body.password ?? "";
    if (!email || !password) return Response.json({ error: "Enter your email and password." }, { status: 400 });

    const ip = clientIpFromRequest(request);
    const allowed = await assertLoginAllowed(email, ip);
    if (!allowed.ok) {
      return Response.json(
        {
          error: "Too many sign-in attempts. Try again later.",
          retryAfterSeconds: allowed.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": String(allowed.retryAfterSeconds) },
        },
      );
    }

    try {
      const user = await signInWithPassword(email, password);
      await clearLoginFailures(email, ip);
      const { token, expiresAt } = await createSession(user.id);
      return Response.json({ email: user.email }, { headers: { "Set-Cookie": serializeSessionCookie(token, expiresAt) } });
    } catch (error) {
      if (error instanceof AuthError) {
        await recordLoginFailure(email, ip);
        return Response.json({ error: error.message }, { status: 401 });
      }
      throw error;
    }
  } catch (error) {
    console.error("login error:", error);
    if (isMissingTableError(error)) {
      return Response.json({ error: "The database schema isn't set up yet. Apply the migration (see README.md) and try again." }, { status: 503 });
    }
    return Response.json({ error: "Could not sign in." }, { status: 500 });
  }
}
