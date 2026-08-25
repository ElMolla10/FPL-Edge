import assert from "node:assert/strict";
import test from "node:test";
import { accumulateLiveStats, seasonStatsThroughEvent } from "../app/lib/fpl.ts";

const FIELDS = ["total_points", "goals_scored", "minutes"];

function makeRawFixture(overrides: Partial<{ id: number; event: number | null; finished: boolean }> = {}) {
  return { id: 1, event: 1, finished: false, ...overrides };
}

function makeElement(id: number, fixtureIds: number[], stats: Record<string, number>) {
  return { id, stats, explain: fixtureIds.map((fixture) => ({ fixture })) };
}

// --- accumulateLiveStats: the actual recalibration -- credit follows the player's own fixture(s), ---
// --- never an event-level finished/data_checked admin flag, which this function never even sees. ---

test("accumulateLiveStats: a finished fixture credits the player's season stats, with no event-level finished/data_checked concept involved at all", () => {
  const fixtures = [makeRawFixture({ id: 1, event: 1, finished: true })];
  const payloads = [{ eventId: 1, payload: { elements: [makeElement(9, [1], { total_points: 6, goals_scored: 1, minutes: 90 })] } }];
  const { seasonStats } = accumulateLiveStats(fixtures, payloads, FIELDS);
  assert.equal(seasonStats.get(9)?.total_points, 6);
  assert.equal(seasonStats.get(9)?.goals_scored, 1);
  assert.equal(seasonStats.get(9)?.appearances, 1);
});

test("accumulateLiveStats: an unfinished fixture does not credit the player's season stats -- the gate still protects against learning from a live match", () => {
  const fixtures = [makeRawFixture({ id: 1, event: 1, finished: false })];
  const payloads = [{ eventId: 1, payload: { elements: [makeElement(9, [1], { total_points: 6, goals_scored: 1, minutes: 90 })] } }];
  const { seasonStats } = accumulateLiveStats(fixtures, payloads, FIELDS);
  assert.equal(seasonStats.has(9), false);
});

test("accumulateLiveStats: a double-gameweek player is credited only once BOTH of their fixtures in that event are finished, never on partial completion", () => {
  const bothFinished = [makeRawFixture({ id: 1, event: 1, finished: true }), makeRawFixture({ id: 2, event: 1, finished: true })];
  const onePending = [makeRawFixture({ id: 1, event: 1, finished: true }), makeRawFixture({ id: 2, event: 1, finished: false })];
  const payload = { eventId: 1, payload: { elements: [makeElement(9, [1, 2], { total_points: 12, goals_scored: 2, minutes: 180 })] } };

  const credited = accumulateLiveStats(bothFinished, [payload], FIELDS);
  assert.equal(credited.seasonStats.get(9)?.total_points, 12, "both legs finished -- the combined stat line is credited");

  const notCredited = accumulateLiveStats(onePending, [payload], FIELDS);
  assert.equal(notCredited.seasonStats.has(9), false, "one leg still live -- the whole (already-summed) stat line must not be partially credited");
});

test("accumulateLiveStats: season totals accumulate correctly across two separate completed gameweeks", () => {
  const fixtures = [makeRawFixture({ id: 1, event: 1, finished: true }), makeRawFixture({ id: 2, event: 2, finished: true })];
  const payloads = [
    { eventId: 1, payload: { elements: [makeElement(9, [1], { total_points: 6, goals_scored: 1, minutes: 90 })] } },
    { eventId: 2, payload: { elements: [makeElement(9, [2], { total_points: 2, goals_scored: 0, minutes: 90 })] } },
  ];
  const { seasonStats } = accumulateLiveStats(fixtures, payloads, FIELDS);
  assert.equal(seasonStats.get(9)?.total_points, 8);
  assert.equal(seasonStats.get(9)?.goals_scored, 1);
  assert.equal(seasonStats.get(9)?.appearances, 2);
});

test("accumulateLiveStats: an unused player (no explain entries, zero minutes) does not crash and contributes nothing", () => {
  const fixtures = [makeRawFixture({ id: 1, event: 1, finished: true })];
  const payloads = [{ eventId: 1, payload: { elements: [makeElement(9, [], { total_points: 0, goals_scored: 0, minutes: 0 })] } }];
  const { seasonStats } = accumulateLiveStats(fixtures, payloads, FIELDS);
  assert.equal(seasonStats.get(9)?.total_points, 0);
  assert.equal(seasonStats.get(9)?.appearances, 0);
});

test("accumulateLiveStats: latestEventStats always tracks the highest event id seen, independent of the season-stat completion gate", () => {
  const fixtures = [makeRawFixture({ id: 1, event: 1, finished: false }), makeRawFixture({ id: 2, event: 2, finished: false })];
  const payloads = [
    { eventId: 1, payload: { elements: [makeElement(9, [1], { total_points: 6, goals_scored: 1, minutes: 90 })] } },
    { eventId: 2, payload: { elements: [makeElement(9, [2], { total_points: 3, goals_scored: 0, minutes: 60 })] } },
  ];
  const { latestEventStats } = accumulateLiveStats(fixtures, payloads, FIELDS);
  assert.equal(latestEventStats.get(9)?.eventId, 2);
  assert.equal(latestEventStats.get(9)?.total_points, 3);
});

// --- seasonStatsThroughEvent: a whole-gameweek floor, independent of the per-player fixture gate above ---

test("seasonStatsThroughEvent: an event with every fixture finished counts as fully complete", () => {
  const events = [{ id: 1 }];
  const fixtures = [makeRawFixture({ id: 1, event: 1, finished: true }), makeRawFixture({ id: 2, event: 1, finished: true })];
  assert.equal(seasonStatsThroughEvent(events, fixtures), 1);
});

test("seasonStatsThroughEvent: an event with even one unfinished fixture is not counted as complete", () => {
  const events = [{ id: 1 }];
  const fixtures = [makeRawFixture({ id: 1, event: 1, finished: true }), makeRawFixture({ id: 2, event: 1, finished: false })];
  assert.equal(seasonStatsThroughEvent(events, fixtures), 0);
});

test("seasonStatsThroughEvent: returns the highest fully-completed event id, not just any completed one", () => {
  const events = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const fixtures = [
    makeRawFixture({ id: 1, event: 1, finished: true }),
    makeRawFixture({ id: 2, event: 2, finished: true }),
    makeRawFixture({ id: 3, event: 3, finished: false }),
  ];
  assert.equal(seasonStatsThroughEvent(events, fixtures), 2);
});

test("seasonStatsThroughEvent: an event with no fixtures at all is not counted as complete", () => {
  const events = [{ id: 1 }];
  const fixtures: ReturnType<typeof makeRawFixture>[] = [];
  assert.equal(seasonStatsThroughEvent(events, fixtures), 0);
});

test("seasonStatsThroughEvent: no events completed anywhere returns 0", () => {
  const events = [{ id: 1 }, { id: 2 }];
  const fixtures = [makeRawFixture({ id: 1, event: 1, finished: false }), makeRawFixture({ id: 2, event: 2, finished: false })];
  assert.equal(seasonStatsThroughEvent(events, fixtures), 0);
});
