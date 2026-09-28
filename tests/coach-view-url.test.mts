import assert from "node:assert/strict";
import test from "node:test";
import { coachViewFromLocation, parseCoachView } from "../app/components/CoachApp.tsx";

test("parseCoachView accepts known views and rejects junk", () => {
  assert.equal(parseCoachView("transfers"), "transfers");
  assert.equal(parseCoachView("DRAFT"), "draft");
  assert.equal(parseCoachView("nope"), null);
  assert.equal(parseCoachView(""), null);
});

test("coachViewFromLocation reads ?view=", () => {
  assert.equal(coachViewFromLocation("?app=1&view=players"), "players");
  assert.equal(coachViewFromLocation("?app=1"), null);
});
