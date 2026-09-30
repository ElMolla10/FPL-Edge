import { isMissingTableError } from "../../../../db";
import { AuthError, createSession, serializeSessionCookie, signInWithPassword } from "../../../lib/auth";
import { MAX_EMAIL_LENGTH, MAX_LOGIN_PASSWORD_LENGTH } from "../../../lib/auth-core";
import { clientIpFromRequest } from "../../../lib/login-rate-limit";
import { assertLoginAllowed, clearLoginFailures, recordLoginFailure } from "../../../lib/login-rate-limit-store";
import { BodyError, bodyErrorResponse, parseStringFields, readJsonBody, rejectCrossSite } from "../../../lib/request-guards";

// Per-account + per-IP rate limits on password sign-in (D1 table login_rate_limits).
// Migration: drizzle/0009_login_rate_limit.sql — uses existing DB binding; no new secrets.
// Successful-login behaviour is unchanged. Added: same-origin check, typed/size-bounded body,
// and a password-length ceiling (MAX_LOGIN_PASSWORD_LENGTH is looser than the signup cap so
// accounts created before the signup cap existed can still sign in).
export async function POST(request: Request) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  try {
    let fields;
    try {
      fields = parseStringFields(await readJsonBody(request), { email: MAX_EMAIL_LENGTH + 1, password: MAX_LOGIN_PASSWORD_LENGTH + 1 });
    } catch (error) {
      const response = bodyErrorResponse(error);
      if (response) return response;
      throw error;
    }
    const email = fields.email?.trim() ?? "";
    const password = fields.password ?? "";
    if (!email || !password) return Response.json({ error: "Enter your email and password." }, { status: 400 });
    if (email.length > MAX_EMAIL_LENGTH || password.length > MAX_LOGIN_PASSWORD_LENGTH) {
      return Response.json({ error: "Email or password is too long." }, { status: 400 });
    }

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
