import { clearSessionCookieHeader, deleteSessionByToken, readSessionCookie } from "../../../lib/auth";
import { rejectCrossSite } from "../../../lib/request-guards";

export async function POST(request: Request) {
  // Cross-site logout is a nuisance CSRF; block it like every other state-changing POST (docs/SECURITY.md).
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  const token = await readSessionCookie();
  if (token) await deleteSessionByToken(token);
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookieHeader() } });
}
