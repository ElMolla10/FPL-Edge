import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FplEvent } from "../app/lib/fpl.ts";

type AverageEvent = FplEvent & { averageEntryScore?: number | null };
type AverageResult = { value: number; provisional: boolean };
type AverageComponentProps = { events: readonly AverageEvent[]; eventId: number };

async function subject() {
  const [routeModule, fplModule, coachModule] = await Promise.all([
    import("../app/api/fpl/route.ts"),
    import("../app/lib/fpl.ts"),
    import("../app/components/CoachApp.tsx"),
  ]);
  return {
    mapOfficialEvent: (routeModule as unknown as { mapOfficialEvent?: (event: Record<string, unknown>) => AverageEvent }).mapOfficialEvent,
    displayedGameweekAverage: (fplModule as unknown as { displayedGameweekAverage?: (events: readonly AverageEvent[], eventId: number) => AverageResult | null }).displayedGameweekAverage,
    GameweekAverage: (coachModule as unknown as { GameweekAverage?: ComponentType<AverageComponentProps> }).GameweekAverage,
  };
}

const rawEvent = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  name: "Gameweek 1",
  deadline_time: "2026-08-21T17:30:00Z",
  is_current: false,
  is_next: false,
  finished: true,
  data_checked: true,
  average_entry_score: 47,
  ...overrides,
});

test("an available official average is mapped and rendered with the GW Average label", async () => {
  const { mapOfficialEvent, displayedGameweekAverage, GameweekAverage } = await subject();
  assert.equal(typeof mapOfficialEvent, "function", "the official event mapper must be exported");
  assert.equal(typeof displayedGameweekAverage, "function", "the displayed-event selector must be exported");
  assert.ok(GameweekAverage, "the Team-page average component must be exported");
  const event = mapOfficialEvent!(rawEvent());
  assert.equal(event.averageEntryScore, 47);
  assert.deepEqual(displayedGameweekAverage!([event], 1), { value: 47, provisional: false });
  const html = renderToStaticMarkup(createElement(GameweekAverage!, { events: [event], eventId: 1 }));
  assert.match(html, /GW Average/);
  assert.match(html, />47</);
  assert.match(html, /Official FPL average/);
  assert.doesNotMatch(html, /provisional/i);
});

test("missing and non-finite official averages remain unavailable and render nothing", async () => {
  const { mapOfficialEvent, displayedGameweekAverage, GameweekAverage } = await subject();
  assert.equal(typeof mapOfficialEvent, "function", "the official event mapper must be exported");
  assert.equal(typeof displayedGameweekAverage, "function", "the displayed-event selector must be exported");
  assert.ok(GameweekAverage, "the Team-page average component must be exported");
  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    const event = mapOfficialEvent!(rawEvent({ average_entry_score: value }));
    assert.equal(event.averageEntryScore, null);
    assert.equal(displayedGameweekAverage!([event], 1), null);
    assert.equal(renderToStaticMarkup(createElement(GameweekAverage!, { events: [event], eventId: 1 })), "");
  }
});

test("an official zero average is preserved and marked live/provisional for an active gameweek", async () => {
  const { mapOfficialEvent, displayedGameweekAverage, GameweekAverage } = await subject();
  assert.equal(typeof mapOfficialEvent, "function", "the official event mapper must be exported");
  assert.equal(typeof displayedGameweekAverage, "function", "the displayed-event selector must be exported");
  assert.ok(GameweekAverage, "the Team-page average component must be exported");
  const event = mapOfficialEvent!(rawEvent({ average_entry_score: 0, is_current: true, finished: false, data_checked: false }));
  assert.deepEqual(displayedGameweekAverage!([event], 1), { value: 0, provisional: true });
  const html = renderToStaticMarkup(createElement(GameweekAverage!, { events: [event], eventId: 1 }));
  assert.match(html, />0</);
  assert.match(html, /Live · provisional/);
});

test("the selector and Team component use the displayed gameweek rather than the current event", async () => {
  const { mapOfficialEvent, displayedGameweekAverage, GameweekAverage } = await subject();
  assert.equal(typeof mapOfficialEvent, "function", "the official event mapper must be exported");
  assert.equal(typeof displayedGameweekAverage, "function", "the displayed-event selector must be exported");
  assert.ok(GameweekAverage, "the Team-page average component must be exported");
  const current = mapOfficialEvent!(rawEvent({ id: 1, average_entry_score: 41, is_current: true, finished: false, data_checked: false }));
  const displayed = mapOfficialEvent!(rawEvent({ id: 2, name: "Gameweek 2", average_entry_score: 56 }));
  assert.deepEqual(displayedGameweekAverage!([current, displayed], 2), { value: 56, provisional: false });
  const html = renderToStaticMarkup(createElement(GameweekAverage!, { events: [current, displayed], eventId: 2 }));
  assert.match(html, />56</);
  assert.doesNotMatch(html, />41</);
  assert.doesNotMatch(html, /provisional/i);
});
