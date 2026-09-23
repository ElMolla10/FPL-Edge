import assert from "node:assert/strict";
import test from "node:test";
import { teamCleanSheetsFromFixtures } from "../app/lib/team-quality.ts";

type RawFixture = { team_h: number; team_a: number; team_h_score: number | null; team_a_score: number | null; finished: boolean };
const fx = (overrides: Partial<RawFixture> = {}): RawFixture => ({ team_h: 1, team_a: 2, team_h_score: 1, team_a_score: 1, finished: true, ...overrides });

test("teamCleanSheetsFromFixtures: a home win 1-0 counts as a clean sheet for the home team, not the away team", () => {
  const fixtures = [fx({ team_h: 1, team_a: 2, team_h_score: 1, team_a_score: 0 })];
  assert.equal(teamCleanSheetsFromFixtures(fixtures, 1), 1, "home team kept a clean sheet");
  assert.equal(teamCleanSheetsFromFixtures(fixtures, 2), 0, "away team conceded, no clean sheet");
});

test("teamCleanSheetsFromFixtures: an away win 0-2 counts as a clean sheet for the away team", () => {
  const fixtures = [fx({ team_h: 1, team_a: 2, team_h_score: 0, team_a_score: 2 })];
  assert.equal(teamCleanSheetsFromFixtures(fixtures, 2), 1, "away team kept a clean sheet");
  assert.equal(teamCleanSheetsFromFixtures(fixtures, 1), 0, "home team conceded, no clean sheet");
});

test("teamCleanSheetsFromFixtures: a 0-0 draw is a clean sheet for both sides", () => {
  const fixtures = [fx({ team_h: 1, team_a: 2, team_h_score: 0, team_a_score: 0 })];
  assert.equal(teamCleanSheetsFromFixtures(fixtures, 1), 1);
  assert.equal(teamCleanSheetsFromFixtures(fixtures, 2), 1);
});

test("teamCleanSheetsFromFixtures: both teams conceding means neither gets a clean sheet", () => {
  const fixtures = [fx({ team_h: 1, team_a: 2, team_h_score: 2, team_a_score: 1 })];
  assert.equal(teamCleanSheetsFromFixtures(fixtures, 1), 0);
  assert.equal(teamCleanSheetsFromFixtures(fixtures, 2), 0);
});

test("teamCleanSheetsFromFixtures: sums clean sheets across multiple finished matches, home and away combined", () => {
  const fixtures = [
    fx({ team_h: 1, team_a: 2, team_h_score: 3, team_a_score: 0 }), // team 1 home clean sheet
    fx({ team_h: 3, team_a: 1, team_h_score: 0, team_a_score: 1 }), // team 1 away clean sheet
    fx({ team_h: 1, team_a: 4, team_h_score: 1, team_a_score: 1 }), // team 1 concedes, no clean sheet
  ];
  assert.equal(teamCleanSheetsFromFixtures(fixtures, 1), 2);
});

test("teamCleanSheetsFromFixtures: unfinished fixtures are never counted, even with a scoreless placeholder score", () => {
  const fixtures = [fx({ team_h: 1, team_a: 2, team_h_score: 0, team_a_score: 0, finished: false })];
  assert.equal(teamCleanSheetsFromFixtures(fixtures, 1), 0, "an in-progress or unplayed fixture must never count as a clean sheet");
});

test("teamCleanSheetsFromFixtures: null scores on a finished fixture are treated as scoreless, not a crash or NaN", () => {
  const fixtures = [fx({ team_h: 1, team_a: 2, team_h_score: 1, team_a_score: null })];
  assert.equal(teamCleanSheetsFromFixtures(fixtures, 1), 1);
});

test("teamCleanSheetsFromFixtures: a team with no fixtures at all returns zero, not NaN or undefined", () => {
  assert.equal(teamCleanSheetsFromFixtures([], 99), 0);
});
