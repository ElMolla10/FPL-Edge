import assert from "node:assert/strict";
import test from "node:test";
import { teamCleanSheetsFromFixtures, teamSeasonStatSum } from "../app/lib/team-quality.ts";

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

// --- teamSeasonStatSum: shared derivation behind both expectedGoalsFor and expectedGoalsAgainst ---

const seasonStatsMap = (rows: [number, Record<string, number>][]) => new Map(rows);

test("teamSeasonStatSum: sums a named season-stat field across every player on the given team, ignoring other teams", () => {
  const elements = [{ id: 1, team: 10 }, { id: 2, team: 10 }, { id: 3, team: 20 }];
  const seasonStats = seasonStatsMap([[1, { expected_goals: 4.2 }], [2, { expected_goals: 2.8 }], [3, { expected_goals: 9 }]]);
  assert.equal(teamSeasonStatSum(elements, 10, seasonStats, "expected_goals"), 7);
});

test("teamSeasonStatSum: expectedGoalsFor and expectedGoalsAgainst read different fields off the same roster, independently", () => {
  const elements = [{ id: 1, team: 10 }, { id: 2, team: 10 }];
  const seasonStats = seasonStatsMap([
    [1, { expected_goals: 3, expected_goals_conceded: 1 }],
    [2, { expected_goals: 2, expected_goals_conceded: 1.5 }],
  ]);
  assert.equal(teamSeasonStatSum(elements, 10, seasonStats, "expected_goals"), 5, "expectedGoalsFor reads expected_goals");
  assert.equal(teamSeasonStatSum(elements, 10, seasonStats, "expected_goals_conceded"), 2.5, "expectedGoalsAgainst reads expected_goals_conceded, not the same number");
});

test("teamSeasonStatSum: a player missing from seasonStats (no minutes yet) contributes zero, not NaN", () => {
  const elements = [{ id: 1, team: 10 }, { id: 2, team: 10 }];
  const seasonStats = seasonStatsMap([[1, { expected_goals: 3 }]]);
  assert.equal(teamSeasonStatSum(elements, 10, seasonStats, "expected_goals"), 3);
});

test("teamSeasonStatSum: a team with no roster entries at all returns zero", () => {
  assert.equal(teamSeasonStatSum([], 10, seasonStatsMap([]), "expected_goals"), 0);
});
