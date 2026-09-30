import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  coachViewFromLocation,
  coachViewSearchParams,
  parseCoachView,
} from "../app/components/CoachApp.tsx";
import { readCoachSource } from "./helpers/coach-source.mts";

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

test("parse/write round-trip for players and transfers (client-side deep links)", () => {
  // Routing is client-side (needs JS); no SSR rewrite — see README.
  const playersSearch = coachViewSearchParams("players", "?app=1");
  assert.equal(coachViewFromLocation(playersSearch), "players");
  assert.match(playersSearch, /view=players/);

  const transfersSearch = coachViewSearchParams("transfers", playersSearch);
  assert.equal(coachViewFromLocation(transfersSearch), "transfers");
  assert.match(transfersSearch, /view=transfers/);
  assert.match(transfersSearch, /app=1/);

  // Overview clears view param but keeps app flag.
  const overviewSearch = coachViewSearchParams("overview", transfersSearch);
  assert.equal(coachViewFromLocation(overviewSearch), null);
  assert.doesNotMatch(overviewSearch, /view=/);
  assert.match(overviewSearch, /app=1/);
});

test("popstate handler is wired for ?view= deep links", () => {
  const src = readCoachSource();
  assert.match(src, /addEventListener\("popstate"/);
  assert.match(src, /coachViewFromLocation\(window\.location\.search\)/);
  assert.match(src, /writeCoachViewToUrl|coachViewSearchParams/);
});
