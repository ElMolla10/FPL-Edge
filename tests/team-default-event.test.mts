import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { defaultTeamEventId } from "../app/lib/team-default-event.ts";

const src = readFileSync(new URL("../app/components/coach/TeamPanel.tsx", import.meta.url), "utf8");

test("fresh session: finished current GW defaults to the upcoming GW (pitch, not empty history)", () => {
  assert.equal(defaultTeamEventId({ id: 5, finished: true }, [{ id: 6 }, { id: 7 }], 1), 6);
});
test("live GW (deadline passed, not finished) is the default", () => {
  assert.equal(defaultTeamEventId({ id: 6, finished: false }, [{ id: 7 }], 1), 6);
});
test("pre-season / no current: first upcoming, then fallback", () => {
  assert.equal(defaultTeamEventId(null, [{ id: 1 }], 1), 1);
  assert.equal(defaultTeamEventId(null, [], 3), 3);
});
test("previous GW stays reachable and keeps its past/receipt branch", () => {
  // prev control decrements navEventId; past branch is decided by event.finished, so a finished GW
  // with no receipt still shows NO RECORD, and one with a lock receipt still shows it.
  assert.match(src, /setNavEventId\(/);
  assert.match(src, /event\.finished\?"past"/);
  assert.match(src, /NO RECORD/);
  assert.match(src, /useState<"Pitch"\|"List">\("Pitch"\)/);
  assert.match(src, /defaultTeamEventId\(currentAnchor,horizonEvents,backwardBoundId\)/);
});
