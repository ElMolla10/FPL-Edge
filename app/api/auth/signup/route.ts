import { AuthError, createSession, serializeSessionCookie, signUpWithPassword } from "../../../lib/auth";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { email?: string; password?: string };
    const email = body.email?.trim() ?? "";
    const password = body.password ?? "";
    if (!email || !email.includes("@")) return Response.json({ error: "Enter a valid email." }, { status: 400 });
    if (password.length < 8) return Response.json({ error: "Password must be at least 8 characters." }, { status: 400 });

    const user = await signUpWithPassword(email, password);
    const { token, expiresAt } = await createSession(user.id);
    return Response.json({ email: user.email }, { headers: { "Set-Cookie": serializeSessionCookie(token, expiresAt) } });
  } catch (error) {
    if (error instanceof AuthError) return Response.json({ error: error.message }, { status: 409 });
    return Response.json({ error: "Could not create account." }, { status: 500 });
  }
}
