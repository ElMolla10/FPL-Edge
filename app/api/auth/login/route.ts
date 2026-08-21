import { isMissingTableError } from "../../../../db";
import { AuthError, createSession, serializeSessionCookie, signInWithPassword } from "../../../lib/auth";

// TODO: no rate-limiting on failed login attempts. Deferred scope cut (see the design
// proposal) -- single/few-user tool, no attacker-facing surface expected yet. Revisit if
// this ever handles untrusted signups at scale.
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { email?: string; password?: string };
    const email = body.email?.trim() ?? "";
    const password = body.password ?? "";
    if (!email || !password) return Response.json({ error: "Enter your email and password." }, { status: 400 });

    const user = await signInWithPassword(email, password);
    const { token, expiresAt } = await createSession(user.id);
    return Response.json({ email: user.email }, { headers: { "Set-Cookie": serializeSessionCookie(token, expiresAt) } });
  } catch (error) {
    if (error instanceof AuthError) return Response.json({ error: error.message }, { status: 401 });
    console.error("login error:", error);
    if (isMissingTableError(error)) {
      return Response.json({ error: "The database schema isn't set up yet. Apply the migration (see README.md) and try again." }, { status: 503 });
    }
    return Response.json({ error: "Could not sign in." }, { status: 500 });
  }
}
