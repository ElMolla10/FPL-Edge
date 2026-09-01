import assert from "node:assert/strict";
import test from "node:test";
import {
  POPULATION_PERCENTILE_TTL_FINISHED_MS,
  POPULATION_PERCENTILE_TTL_LIVE_MS,
  buildCurveFromSamples,
  getPopulationPercentiles,
  isPercentileCacheStale,
  logSpacedPages,
  sampleOverallCurve,
} from "../app/lib/population-percentile-core.ts";
import type { PercentileCacheRepo, PercentileCacheRow, PercentileCurvePoint } from "../app/lib/population-percentile-core.ts";

function makeInMemoryRepo(seed: PercentileCacheRow | null = null): PercentileCacheRepo & { writes: PercentileCacheRow[] } {
  let row = seed;
  const writes: PercentileCacheRow[] = [];
  return {
    writes,
    async read() { return row; },
    async write(next) { row = next; writes.push(next); },
  };
}

const row = (overrides: Partial<PercentileCacheRow> = {}): PercentileCacheRow => ({
  id: "overall", eventId: 6, eventFinished: false, totalPlayers: 10_000_000,
  curve: [{ rank: 1, points: 200 }, { rank: 5_000_000, points: 80 }],
  omittedSamples: 0, sampledAt: "2026-09-01T00:00:00.000Z", recentAverageGameweekScore: 55,
  ...overrides,
});

test("logSpacedPages: boundaries always land on page 1 and maxPage, ascending and de-duplicated", () => {
  const pages = logSpacedPages(198_113, 29);
  assert.equal(pages[0], 1);
  assert.equal(pages[pages.length - 1], 198_113);
  for (let i = 1; i < pages.length; i++) assert.ok(pages[i] > pages[i - 1], "must be strictly ascending after de-dup");
  assert.ok(pages.length <= 29, "de-duplication can only reduce the count, never exceed sampleCount");
});

test("logSpacedPages: is denser near the top of the table than near the bottom", () => {
  const pages = logSpacedPages(1_000_000, 20);
  const firstTenthGap = pages[9] - pages[0];
  const lastTenthGap = pages[pages.length - 1] - pages[pages.length - 10];
  assert.ok(firstTenthGap < lastTenthGap, "the first several samples must cover far fewer pages than the last several");
});

test("logSpacedPages: maxPage of 1 returns exactly [1]; invalid inputs throw", () => {
  assert.deepEqual(logSpacedPages(1, 29), [1]);
  assert.throws(() => logSpacedPages(0, 29));
  assert.throws(() => logSpacedPages(100, 1));
  assert.throws(() => logSpacedPages(-5, 29));
});

test("isPercentileCacheStale: two-tier TTL -- live events go stale far sooner than finished ones", () => {
  const now = Date.parse("2026-09-01T05:00:00.000Z"); // 5h after sampledAt above
  assert.equal(isPercentileCacheStale(row({ eventFinished: false }), now), true, "5h exceeds the 2h live TTL");
  assert.equal(isPercentileCacheStale(row({ eventFinished: true }), now), false, "5h is within the 12h finished TTL");
  const laterNow = Date.parse("2026-09-01T13:00:00.000Z"); // 13h after sampledAt
  assert.equal(isPercentileCacheStale(row({ eventFinished: true }), laterNow), true, "13h exceeds the 12h finished TTL");
});

test("isPercentileCacheStale: exact TTL boundary and unparseable sampledAt", () => {
  const sampledAt = "2026-09-01T00:00:00.000Z";
  const justUnderLive = Date.parse(sampledAt) + POPULATION_PERCENTILE_TTL_LIVE_MS - 1;
  const justOverLive = Date.parse(sampledAt) + POPULATION_PERCENTILE_TTL_LIVE_MS + 1;
  assert.equal(isPercentileCacheStale(row({ eventFinished: false, sampledAt }), justUnderLive), false);
  assert.equal(isPercentileCacheStale(row({ eventFinished: false, sampledAt }), justOverLive), true);
  assert.equal(isPercentileCacheStale(row({ sampledAt: "not-a-real-date" }), Date.now()), true);
});

test("buildCurveFromSamples: an adversarial mix of malformed samples is omitted, counted, and never enters the curve", () => {
  const samples: (PercentileCurvePoint | null)[] = [
    { rank: 5, points: 190 },
    null, // an empty/failed page
    { rank: 1.5, points: 200 } as PercentileCurvePoint, // non-integer rank
    { rank: -3, points: 200 }, // negative rank
    { rank: 10, points: -1 }, // negative points
    { rank: 20, points: Number.NaN }, // non-finite points
    { rank: 1, points: 227 },
    { rank: 2, points: 999 },
  ];
  const { curve, omittedSamples } = buildCurveFromSamples(samples);
  assert.equal(omittedSamples, 5, "exactly the five malformed/empty samples must be counted as omitted");
  assert.deepEqual(curve, [
    { rank: 1, points: 227 },
    { rank: 2, points: 999 },
    { rank: 5, points: 190 },
  ], "only the three valid samples survive, sorted ascending by rank");
});

test("buildCurveFromSamples: an all-valid input reports zero omissions", () => {
  const { curve, omittedSamples } = buildCurveFromSamples([{ rank: 3, points: 1 }, { rank: 1, points: 5 }]);
  assert.equal(omittedSamples, 0);
  assert.deepEqual(curve, [{ rank: 1, points: 5 }, { rank: 3, points: 1 }]);
});

test("sampleOverallCurve: requests exactly the log-spaced pages and aggregates through buildCurveFromSamples", async () => {
  const requested: number[] = [];
  const fetchPage = async (page: number): Promise<PercentileCurvePoint | null> => {
    requested.push(page);
    return page === 1 ? null : { rank: page * 10, points: 300 - page };
  };
  const { curve, omittedSamples } = await sampleOverallCurve({ maxPage: 100, sampleCount: 10, fetchPage });
  assert.deepEqual(requested, logSpacedPages(100, 10));
  assert.equal(omittedSamples, 1, "the page=1 sample returned null and must be omitted");
  assert.equal(curve.length, requested.length - 1);
});

test("getPopulationPercentiles: a fresh cached row is returned without any live calls", async () => {
  const cached = row({ sampledAt: new Date().toISOString() });
  const repo = makeInMemoryRepo(cached);
  const result = await getPopulationPercentiles({
    repo, now: Date.now,
    fetchCurrentEvent: async () => { throw new Error("must not be called when the cache is fresh"); },
    fetchPage: async () => { throw new Error("must not be called when the cache is fresh"); },
  });
  assert.equal(result.status, "available");
  if (result.status === "available") {
    assert.equal(result.stale, false);
    assert.equal(result.eventId, cached.eventId);
  }
  assert.equal(repo.writes.length, 0);
});

test("getPopulationPercentiles: no cache performs a live refresh, computes maxPage from totalPlayers, and writes the result", async () => {
  const repo = makeInMemoryRepo(null);
  const requestedPages: number[] = [];
  const result = await getPopulationPercentiles({
    repo, now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    fetchCurrentEvent: async () => ({ eventId: 6, eventFinished: false, totalPlayers: 500, recentAverageGameweekScore: 55 }), // maxPage = ceil(500/50) = 10
    fetchPage: async (page) => { requestedPages.push(page); return { rank: page, points: 100 - page }; },
    sampleCount: 5,
  });
  assert.equal(result.status, "available");
  if (result.status === "available") {
    assert.equal(result.stale, false);
    assert.equal(result.eventId, 6);
    assert.equal(result.totalPlayers, 500);
  }
  assert.deepEqual(requestedPages, logSpacedPages(10, 5));
  assert.equal(repo.writes.length, 1);
  assert.equal(repo.writes[0].id, "overall");
});

test("getPopulationPercentiles: a stale cache with a successful refresh overwrites the row with fresh data", async () => {
  const stale = row({ sampledAt: "2020-01-01T00:00:00.000Z", eventId: 3 });
  const repo = makeInMemoryRepo(stale);
  const result = await getPopulationPercentiles({
    repo, now: Date.now,
    fetchCurrentEvent: async () => ({ eventId: 9, eventFinished: false, totalPlayers: 100, recentAverageGameweekScore: 60 }),
    fetchPage: async (page) => ({ rank: page, points: 1 }),
    sampleCount: 3,
  });
  assert.equal(result.status, "available");
  if (result.status === "available") { assert.equal(result.stale, false); assert.equal(result.eventId, 9); }
  assert.equal(repo.writes.length, 1);
  assert.equal(repo.writes[0].eventId, 9);
});

test("getPopulationPercentiles: a stale cache falls back to the prior row, marked stale, when the refresh fails -- and never overwrites it", async () => {
  const stale = row({ sampledAt: "2020-01-01T00:00:00.000Z" });
  const repo = makeInMemoryRepo(stale);
  const result = await getPopulationPercentiles({
    repo, now: Date.now,
    fetchCurrentEvent: async () => { throw new Error("upstream is down"); },
    fetchPage: async () => ({ rank: 1, points: 1 }),
  });
  assert.equal(result.status, "available");
  if (result.status === "available") {
    assert.equal(result.stale, true);
    assert.equal(result.eventId, stale.eventId, "must be the OLD cached data, not a fabricated fresh one");
  }
  assert.equal(repo.writes.length, 0, "a failed refresh must never overwrite the last known-good row");
});

test("getPopulationPercentiles: no cache and a failed refresh is an honest unavailable result, never a fabricated curve", async () => {
  const repo = makeInMemoryRepo(null);
  const result = await getPopulationPercentiles({
    repo, now: Date.now,
    fetchCurrentEvent: async () => { throw new Error("upstream is down"); },
    fetchPage: async () => ({ rank: 1, points: 1 }),
  });
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") assert.match(result.reason, /upstream is down/);
});

test("getPopulationPercentiles: every sample coming back unusable is treated as a failed refresh, not an empty-but-available curve", async () => {
  const repo = makeInMemoryRepo(null);
  const result = await getPopulationPercentiles({
    repo, now: Date.now,
    fetchCurrentEvent: async () => ({ eventId: 6, eventFinished: false, totalPlayers: 100, recentAverageGameweekScore: 55 }),
    fetchPage: async () => null, // every single sample page failed
    sampleCount: 3,
  });
  assert.equal(result.status, "unavailable");
  assert.equal(repo.writes.length, 0);
});
