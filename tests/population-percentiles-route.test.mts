import assert from "node:assert/strict";
import test from "node:test";
import { createPopulationPercentilesRoute } from "../app/api/fpl/population-percentiles/route.ts";
import type { PopulationPercentileResult } from "../app/lib/population-percentile.ts";

const available: PopulationPercentileResult = {
  status: "available",
  eventId: 6,
  eventFinished: false,
  totalPlayers: 10_185_305,
  curve: [{ rank: 1, points: 227 }, { rank: 5_000_000, points: 80 }],
  sampledAt: "2026-09-01T00:00:00.000Z",
  stale: false,
  omittedSamples: 0,
  recentAverageGameweekScore: 55,
};

test("route returns the available result with a public, cacheable header -- this data is population-wide, not per-user", async () => {
  const GET = createPopulationPercentilesRoute({ get: async () => available });
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=300");
  assert.deepEqual(await response.json(), available);
});

test("route surfaces an unavailable result as 503 with the real reason, no-store", async () => {
  const GET = createPopulationPercentilesRoute({ get: async () => ({ status: "unavailable", reason: "upstream is down" }) });
  const response = await GET();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { error: "upstream is down" });
});

test("route passes through a stale-but-available result honestly rather than hiding staleness", async () => {
  const GET = createPopulationPercentilesRoute({ get: async () => ({ ...available, stale: true }) });
  const response = await GET();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.stale, true);
});
