import assert from "node:assert/strict";
import test from "node:test";
import { createMiniLeagueRoute } from "../app/api/fpl/league/route.ts";
import { MiniLeagueGatewayError } from "../app/lib/mini-league-server.ts";
import type { MiniLeagueStandingsResult } from "../app/lib/mini-league.ts";

const result: MiniLeagueStandingsResult = {
  source: "official-fpl",
  seasonOver: false,
  partial: false,
  league: { id: 123, name: "Friends", scoring: "c", closed: false, startEvent: 1 },
  connectedManager: { entryId: 7, rank: 3, lastRank: 4, rankChange: 1, gameweekPoints: 60, totalPoints: 100, page: 1, leagueSize: 10 },
  standings: { page: 1, hasNext: false, rows: [] },
  freshness: { officialUpdatedAt: "2026-08-31T09:00:00Z", fetchedAt: "2026-08-31T09:01:00Z", stale: false, warnings: [] },
};

test("route validates query parameters before calling the gateway", async () => {
  let calls = 0;
  const GET = createMiniLeagueRoute({ loadStandings: async () => { calls++; return result; } });
  const response = await GET(new Request("http://localhost/api/fpl/league?league=0&entry=abc&page=201"));
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
  assert.match((await response.json()).error, /league must be/i);
});

test("route forwards only validated integers and returns private no-store JSON", async () => {
  let received: unknown;
  const GET = createMiniLeagueRoute({ loadStandings: async input => { received = input; return result; } });
  const response = await GET(new Request("http://localhost/api/fpl/league?league=123&entry=7&page=2"));
  assert.equal(response.status, 200);
  assert.deepEqual(received, { leagueId: 123, entryId: 7, page: 2 });
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await response.json(), result);
});

test("route preserves honest gateway status and retry metadata", async () => {
  const GET = createMiniLeagueRoute({ loadStandings: async () => {
    throw new MiniLeagueGatewayError(504, "Official FPL request timed out.", "fpl-timeout", true);
  } });
  const response = await GET(new Request("http://localhost/api/fpl/league?league=123&entry=7"));
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "Official FPL request timed out.", code: "fpl-timeout", retryable: true });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("route does not expose arbitrary unexpected error text", async () => {
  const GET = createMiniLeagueRoute({ loadStandings: async () => { throw new Error("database-password=secret"); } });
  const response = await GET(new Request("http://localhost/api/fpl/league?league=123&entry=7"));
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error, "The Mini-League request failed unexpectedly.");
  assert.doesNotMatch(JSON.stringify(body), /database-password|secret/);
});
