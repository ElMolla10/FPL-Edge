import { getDb, isMissingTableError } from "../../../db";
import { users } from "../../../db/schema";
import { createConcurrencyLimiter, fetchWithTimeout, FetchLike } from "../../lib/fpl-gateway";

// One check at a time is plenty for a route an external monitor pings every few minutes -- this
// isn't a rate-sensitive gateway serving concurrent users, just this route's own single upstream
// probe. Reuses fetchWithTimeout (app/lib/fpl-gateway.ts) rather than a second bespoke timeout
// implementation, same as Mini-League's and the population-percentile sampler's gateways.
const limiter = createConcurrencyLimiter(1);

export type HealthCheck = { ok: boolean; detail?: string };

// DI'd on the DB probe and the fetcher, same pattern as app/lib/auth-core.ts/entitlement.ts, so
// this can be unit-tested (tests/health-route.test.mts) without hitting real D1 or FPL's real API
// on every test run.
export async function runHealthChecksWith(checkDatabase: () => Promise<void>, fetcher: FetchLike): Promise<Record<string, HealthCheck>> {
  const checks: Record<string, HealthCheck> = {};

  try {
    await checkDatabase();
    checks.database = { ok: true };
  } catch (error) {
    checks.database = {
      ok: false,
      detail: isMissingTableError(error) ? "D1 reachable, but migrations not applied" : error instanceof Error ? error.message : "unknown error",
    };
  }

  try {
    const response = await fetchWithTimeout("https://fantasy.premierleague.com/api/bootstrap-static/", {
      fetcher,
      limiter,
      timeoutMs: 5000,
      headers: { Accept: "application/json", "User-Agent": "FPL-Edge-Health/1.0" },
    });
    checks.fplUpstream = response.ok ? { ok: true } : { ok: false, detail: `status ${response.status}` };
  } catch (error) {
    checks.fplUpstream = { ok: false, detail: error instanceof Error ? error.message : "unreachable" };
  }

  return checks;
}

async function checkDatabase(): Promise<void> {
  const db = await getDb();
  await db.select({ id: users.id }).from(users).limit(1);
}

// A 503 (not 200-with-a-false-field) on failure is deliberate -- an external uptime monitor
// checking for a 200 response (the common free-tier default, no body/keyword matching required)
// then correctly reports this as down without any special configuration on the monitor's side.
export async function GET() {
  const checks = await runHealthChecksWith(checkDatabase, fetch);
  const healthy = Object.values(checks).every((check) => check.ok);
  return Response.json(
    { healthy, checks, checkedAt: new Date().toISOString() },
    { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } }
  );
}
