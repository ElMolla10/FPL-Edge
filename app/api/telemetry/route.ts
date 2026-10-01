import { getUserBySessionToken, readSessionCookie } from "../../lib/auth";
import { clientIpFromRequest } from "../../lib/login-rate-limit";
import { readJsonBody, rejectCrossSite } from "../../lib/request-guards";
import { allowTelemetry, sanitizeTelemetry, type RateWindow } from "../../lib/telemetry";
import { insertTelemetry } from "../../lib/telemetry-store";

const windows = new Map<string, RateWindow>();
const done = (status = 204) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });

// First-party funnel beacon. Always answers 204/403/413/429 — never 500.
export async function POST(request: Request) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  if (!allowTelemetry(windows, clientIpFromRequest(request), Date.now())) return done(429);
  let body: unknown;
  try { body = await readJsonBody(request, 2048); } catch { return done(400); }
  const event = sanitizeTelemetry(body);
  if (!event) return done();
  let userId: string | null = null;
  try {
    const token = await readSessionCookie();
    if (token) userId = (await getUserBySessionToken(token))?.id ?? null;
  } catch { userId = null; }
  await insertTelemetry(event, userId);
  return done();
}
