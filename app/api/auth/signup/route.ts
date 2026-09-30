import { isMissingTableError } from "../../../../db";
import { registerAccount } from "../../../lib/auth";
import { MAX_EMAIL_LENGTH, validateNewPassword } from "../../../lib/auth-core";
import { clientIpFromRequest } from "../../../lib/login-rate-limit";
import { consumeSignupAttempt } from "../../../lib/login-rate-limit-store";
import { BodyError, bodyErrorResponse, parseStringFields, readJsonBody, rejectCrossSite } from "../../../lib/request-guards";

// Non-oracle signup (audit item 1). The response is IDENTICAL for a brand-new email and for one that
// is already registered: 200 {"ok":true,"status":"check-your-email"} and NO session cookie. The
// previous behaviour (409 "account already exists" for duplicates, a live session for new emails)
// let anyone probe which emails have accounts. Trade-off: with no email-sending infra there is no
// way to tell a genuine new user "your account is ready" out of band, so a new user must now sign in
// after signup (the UI does this automatically, see AuthForm/CoachApp). See docs/SECURITY.md.
//
// Rate limited per client IP (audit item 2) BEFORE any PBKDF2 work: 429 + Retry-After, same shape as login.
export async function POST(request: Request) {
  const blocked = rejectCrossSite(request);
  if (blocked) return blocked;
  try {
    let fields;
    try {
      fields = parseStringFields(await readJsonBody(request), { email: MAX_EMAIL_LENGTH + 1, password: 4096 });
    } catch (error) {
      const response = bodyErrorResponse(error);
      if (response) return response;
      throw error;
    }
    const email = fields.email?.trim() ?? "";
    const password = fields.password ?? "";
    if (!email || !email.includes("@") || email.length > MAX_EMAIL_LENGTH) return Response.json({ error: "Enter a valid email." }, { status: 400 });
    const passwordProblem = validateNewPassword(password);
    if (passwordProblem) return Response.json({ error: passwordProblem }, { status: 400 });

    const ip = clientIpFromRequest(request);
    const allowed = await consumeSignupAttempt(ip);
    if (!allowed.ok) {
      return Response.json(
        { error: "Too many sign-up attempts. Try again later.", retryAfterSeconds: allowed.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(allowed.retryAfterSeconds) } },
      );
    }

    await registerAccount(email, password);
    return Response.json({ ok: true, status: "check-your-email" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof BodyError) return Response.json({ error: error.message }, { status: error.status });
    console.error("signup error:", error);
    if (isMissingTableError(error)) {
      return Response.json({ error: "The database schema isn't set up yet. Apply the migration (see README.md) and try again." }, { status: 503 });
    }
    return Response.json({ error: "Could not create account." }, { status: 500 });
  }
}
