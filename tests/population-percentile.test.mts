import assert from "node:assert/strict";
import test from "node:test";
import { makeLiveDependencies } from "../app/lib/population-percentile.ts";

function fakeFetcher(response: unknown, status = 200) {
  return async () => status >= 200 && status < 300
    ? Response.json(response, { status })
    : new Response(JSON.stringify(response), { status });
}

function bootstrapPayload(overrides: Record<string, unknown> = {}) {
  return {
    total_players: 10_185_305,
    events: Array.from({ length: 38 }, (_, index) => ({
      id: index + 1,
      is_current: index + 1 === 6,
      is_next: index + 1 === 7,
      finished: index + 1 < 6,
    })),
    ...overrides,
  };
}

function standingsPayload(rows: Record<string, unknown>[]) {
  return { standings: { results: rows } };
}

test("fetchCurrentEvent: reads the is_current event's id/finished plus total_players from real bootstrap-static shape", async () => {
  const deps = makeLiveDependencies({ fetcher: fakeFetcher(bootstrapPayload()) });
  const result = await deps.fetchCurrentEvent();
  assert.deepEqual(result, { eventId: 6, eventFinished: false, totalPlayers: 10_185_305 });
});

test("fetchCurrentEvent: a finished current event is reported as finished, not assumed live", async () => {
  const finishedEvents = Array.from({ length: 38 }, (_, index) => ({
    id: index + 1, is_current: index + 1 === 6, is_next: false, finished: index + 1 <= 6,
  }));
  const deps = makeLiveDependencies({ fetcher: fakeFetcher(bootstrapPayload({ events: finishedEvents })) });
  const result = await deps.fetchCurrentEvent();
  assert.equal(result.eventFinished, true);
});

test("fetchCurrentEvent: no is_current event anywhere throws rather than guessing one", async () => {
  const noCurrentEvents = Array.from({ length: 38 }, (_, index) => ({ id: index + 1, is_current: false, is_next: index + 1 === 1, finished: false }));
  const deps = makeLiveDependencies({ fetcher: fakeFetcher(bootstrapPayload({ events: noCurrentEvents })) });
  await assert.rejects(() => deps.fetchCurrentEvent(), /no current event/i);
});

test("fetchCurrentEvent: missing total_players or a non-array events field is treated as malformed", async () => {
  const missingTotal = makeLiveDependencies({ fetcher: fakeFetcher(bootstrapPayload({ total_players: "not-a-number" })) });
  await assert.rejects(() => missingTotal.fetchCurrentEvent(), /malformed/i);
  const missingEvents = makeLiveDependencies({ fetcher: fakeFetcher({ total_players: 100, events: "nope" }) });
  await assert.rejects(() => missingEvents.fetchCurrentEvent(), /malformed/i);
});

test("fetchCurrentEvent: a non-ok response throws with the real status code in the message", async () => {
  const deps = makeLiveDependencies({ fetcher: fakeFetcher({ detail: "down" }, 503) });
  await assert.rejects(() => deps.fetchCurrentEvent(), /503/);
});

test("fetchPage: reads rank/total from the first standings row, matching the field Mini-League already trusts", async () => {
  const deps = makeLiveDependencies({ fetcher: fakeFetcher(standingsPayload([{ rank: 3507, total: 188, entry_name: "x" }])) });
  const result = await deps.fetchPage(102);
  assert.deepEqual(result, { rank: 3507, points: 188 });
});

test("fetchPage: an empty results array (edge-of-population overshoot) is a clean null, not an error", async () => {
  const deps = makeLiveDependencies({ fetcher: fakeFetcher(standingsPayload([])) });
  assert.equal(await deps.fetchPage(198_113), null);
});

test("fetchPage: a malformed row (missing rank or total) is a null, not a thrown error that would abort the whole refresh", async () => {
  const missingRank = makeLiveDependencies({ fetcher: fakeFetcher(standingsPayload([{ total: 188 }])) });
  assert.equal(await missingRank.fetchPage(1), null);
  const missingTotal = makeLiveDependencies({ fetcher: fakeFetcher(standingsPayload([{ rank: 1 }])) });
  assert.equal(await missingTotal.fetchPage(1), null);
});

test("fetchPage: a non-ok response is a null, not a thrown error", async () => {
  const deps = makeLiveDependencies({ fetcher: fakeFetcher({ detail: "not found" }, 404) });
  assert.equal(await deps.fetchPage(1), null);
});

test("fetchPage: a fetcher that throws (network failure, timeout) is caught and reported as a null sample, not a fatal error", async () => {
  const deps = makeLiveDependencies({ fetcher: async () => { throw new Error("network down"); } });
  assert.equal(await deps.fetchPage(1), null);
});
