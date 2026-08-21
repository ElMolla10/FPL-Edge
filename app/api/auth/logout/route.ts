import { clearSessionCookieHeader, deleteSessionByToken, readSessionCookie } from "../../../lib/auth";

export async function POST() {
  const token = await readSessionCookie();
  if (token) await deleteSessionByToken(token);
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookieHeader() } });
}
