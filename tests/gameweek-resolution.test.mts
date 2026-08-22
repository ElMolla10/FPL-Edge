import assert from "node:assert/strict";
import test from "node:test";
import { FplEvent, futureEvents } from "../app/lib/fpl.ts";

function makeEvent(overrides: Partial<FplEvent> = {}): FplEvent {
  return {
    id: 1, name: "Gameweek 1", deadline: new Date(Date.now() + 86400000).toISOString(),
    current: false, next: false, finished: false, dataChecked: false,
    ...overrides,
  };
}

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3600000).toISOString();
}

// The exact live scenario that was broken: GW1's deadline passed less than 24 hours ago (17.4h,
// matching the real live check at the time this was found) and GW1 has not finished playing yet.
// GW2's deadline is genuinely in the future. Before the fix, the old grace window
// (deadline > now - 86400000) meant GW1 was STILL included here, so futureEvents()[0] stayed GW1
// for a full day after its own deadline -- DeadlineClock, Transfers, Final Check, Overview, Draft
// Lab, Fixtures, Players and Watchlist were all still planning around a gameweek nobody could act
// on anymore. The fix drops the grace window entirely.
test("futureEvents: an event whose deadline passed 17.4 hours ago (inside the old 24h grace window) is excluded, and the next valid event becomes position 0", () => {
  const gw1 = makeEvent({ id: 1, name: "Gameweek 1", deadline: hoursFromNow(-17.4), finished: false, current: true });
  const gw2 = makeEvent({ id: 2, name: "Gameweek 2", deadline: hoursFromNow(150.6), finished: false, next: true });
  const data = { events: [gw1, gw2] } as any;

  const result = futureEvents(data, 8);

  assert.equal(result.length, 1, "GW1 must not appear at all -- its deadline has passed");
  assert.equal(result[0].id, 2, "GW2 must be position 0, not GW1");
});

test("futureEvents: an event whose deadline passed even 1 second ago is excluded -- not just past the old 24h window", () => {
  const justPassed = makeEvent({ id: 1, deadline: new Date(Date.now() - 1000).toISOString(), finished: false });
  const next = makeEvent({ id: 2, deadline: hoursFromNow(24) });
  const data = { events: [justPassed, next] } as any;

  const result = futureEvents(data, 8);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 2);
});

test("futureEvents: an event whose deadline is still in the future is included", () => {
  const upcoming = makeEvent({ id: 1, deadline: hoursFromNow(1) });
  const data = { events: [upcoming] } as any;

  const result = futureEvents(data, 8);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 1);
});

test("futureEvents: a finished event is excluded even if its deadline is somehow still in the future (defensive)", () => {
  const oddlyFinished = makeEvent({ id: 1, deadline: hoursFromNow(1), finished: true });
  const data = { events: [oddlyFinished] } as any;

  const result = futureEvents(data, 8);

  assert.deepEqual(result, []);
});

test("futureEvents: returns valid future events in order, respecting the count limit", () => {
  const events = [1, 2, 3, 4, 5].map((n) => makeEvent({ id: n, deadline: hoursFromNow(n * 24) }));
  const data = { events } as any;

  const result = futureEvents(data, 3);

  assert.deepEqual(result.map((e) => e.id), [1, 2, 3]);
});

test("futureEvents: no events qualify (all past or finished) -- returns empty, matching the 'season complete' path downstream", () => {
  const allDone = [
    makeEvent({ id: 1, deadline: hoursFromNow(-500), finished: true }),
    makeEvent({ id: 2, deadline: hoursFromNow(-2), finished: false }),
  ];
  const data = { events: allDone } as any;

  assert.deepEqual(futureEvents(data, 8), []);
});
