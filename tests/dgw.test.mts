import assert from "node:assert/strict";
import test from "node:test";
import { FplFixture, FplPlayer, isValidSquad, projectionMetrics } from "../app/lib/fpl.ts";
import { Transfer, bestTransfers, opponent } from "../app/components/CoachApp.tsx";

function makePlayer(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1, name: "Peak Forward", firstName: "Peak", secondName: "Forward", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: 4, position: "Forward", positionShort: "FWD", price: 15, status: "a", chance: null,
    epNext: 9, form: 9, pointsPerGame: 10, priorPointsPerGame: 10, priorMinutes: 3400, priorStarts: 37,
    priorExpectedGoals: 42, priorExpectedAssists: 8, priorBonus: 34, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 0, totalPoints: 0, eventPoints: 0, selectedBy: 55, priceChange: 0,
    transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0,
    expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 0,
    starts: 0, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0,
    penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: 1, directFreekicksOrder: 1, cornersOrder: 1, scoutRisks: [], news: "", newsAdded: null,
    ...overrides,
  };
}

function makeFixture(overrides: Partial<FplFixture> = {}): FplFixture {
  return {
    id: 1, event: 1, teamH: 1, teamA: 2, teamHDifficulty: 3, teamADifficulty: 3,
    finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null,
    ...overrides,
  };
}

function makeRules() {
  return {
    budget: 100,
    squadSize: 15,
    teamLimit: 3,
    positions: [
      { id: 1, name: "Goalkeeper", short: "GKP", squad: 2, minPlay: 1, maxPlay: 1 },
      { id: 2, name: "Defender", short: "DEF", squad: 5, minPlay: 3, maxPlay: 5 },
      { id: 3, name: "Midfielder", short: "MID", squad: 5, minPlay: 2, maxPlay: 5 },
      { id: 4, name: "Forward", short: "FWD", squad: 3, minPlay: 1, maxPlay: 3 },
    ],
  };
}

const teams = [
  { id: 1, name: "Test FC", short: "TFC" },
  { id: 2, name: "Arsenal", short: "ARS" },
  { id: 3, name: "Chelsea", short: "CHE" },
];

// --- projectionMetrics: the clamp(0,16) ceiling must scale with fixture count ---

test("projectionMetrics: a single fixture is still capped near the single-match ceiling", () => {
  const player = makePlayer();
  const fixtures = [makeFixture({ id: 1, event: 10, teamH: 1, teamA: 2, teamHDifficulty: 1, teamADifficulty: 5 })];
  const m = projectionMetrics(player, 10, fixtures, 10);
  assert.ok(m.xPts <= 16, `single-fixture xPts (${m.xPts.toFixed(2)}) must not exceed the single-match ceiling of 16`);
});

test("projectionMetrics: a genuine double gameweek is not silently compressed toward the single-match ceiling", () => {
  const player = makePlayer();
  const single = [makeFixture({ id: 1, event: 10, teamH: 1, teamA: 2, teamHDifficulty: 1, teamADifficulty: 5 })];
  const double = [
    makeFixture({ id: 2, event: 11, teamH: 1, teamA: 3, teamHDifficulty: 1, teamADifficulty: 5 }),
    makeFixture({ id: 3, event: 11, teamH: 1, teamA: 4, teamHDifficulty: 1, teamADifficulty: 5 }),
  ];
  const singleResult = projectionMetrics(player, 10, single, 10);
  const doubleResult = projectionMetrics(player, 11, double, 10);
  const ratio = doubleResult.xPts / singleResult.xPts;
  assert.ok(
    ratio > 1.9,
    `two identical-quality fixtures in one event should be worth close to 2x a single one of them -- got ${ratio.toFixed(2)}x (single=${singleResult.xPts.toFixed(2)}, double=${doubleResult.xPts.toFixed(2)}), which means the ceiling is still compressing the double`,
  );
  assert.ok(doubleResult.xPts <= 32, `double-fixture xPts (${doubleResult.xPts.toFixed(2)}) must not exceed 2x the single-match ceiling`);
});

test("projectionMetrics: a blank gameweek (zero fixtures) still projects zero, unaffected by the ceiling change", () => {
  const player = makePlayer();
  const m = projectionMetrics(player, 99, [], 10);
  assert.equal(m.xPts, 0);
});

// --- opponent(): must show every fixture in a double, not silently drop one ---

test("opponent: single fixture -- unchanged, one label", () => {
  const player = makePlayer();
  const fixtures = [makeFixture({ event: 5, teamH: 1, teamA: 2 })];
  const data = { teams, fixtures } as any;
  assert.equal(opponent(player, 5, data), "ARS H");
});

test("opponent: blank gameweek -- still BLANK, not silently something else", () => {
  const player = makePlayer();
  const data = { teams, fixtures: [] } as any;
  assert.equal(opponent(player, 5, data), "BLANK");
});

test("opponent: double gameweek -- shows both fixtures, not just the first one found", () => {
  const player = makePlayer();
  const fixtures = [
    makeFixture({ id: 1, event: 7, teamH: 1, teamA: 2 }),
    makeFixture({ id: 2, event: 7, teamH: 3, teamA: 1 }),
  ];
  const data = { teams, fixtures } as any;
  assert.equal(opponent(player, 7, data), "ARS H, CHE A");
});

// --- bestTransfers: fixtureAdjustmentIn must not silently drop one leg of a double gameweek ---

test("bestTransfers: an incoming player's fixture-adjustment reflects both legs of a double gameweek, not just one", () => {
  const out = makePlayer({ id: 2, positionId: 4, position: "Forward", positionShort: "FWD", price: 5.5, teamId: 1, priorPointsPerGame: 2, selectedBy: 5 });
  const gkps = [1, 2].map((n) => makePlayer({ id: n, positionId: 1, position: "Goalkeeper", positionShort: "GKP", price: 4.5, teamId: 100 + n }));
  const defs = [1, 2, 3, 4, 5].map((n) => makePlayer({ id: 10 + n, positionId: 2, position: "Defender", positionShort: "DEF", price: 4.5, teamId: 110 + n }));
  const mids = [1, 2, 3, 4, 5].map((n) => makePlayer({ id: 20 + n, positionId: 3, position: "Midfielder", positionShort: "MID", price: 5.0, teamId: 120 + n }));
  const fwds = [out, ...[1, 2].map((n) => makePlayer({ id: 30 + n, positionId: 4, position: "Forward", positionShort: "FWD", price: 5.5, teamId: 130 + n }))];
  const squad = [...gkps, ...defs, ...mids, ...fwds];
  assert.equal(squad.length, 15);

  // Candidate has a double gameweek in the very next event: one very easy fixture (difficulty 1)
  // and one very hard one (difficulty 5). The correct average is 3 -- a .find()-based lookup would
  // silently pick whichever fixture happens to be first in the array and report 1 or 5, not 3.
  const candidate = makePlayer({ id: 500, positionId: 4, position: "Forward", positionShort: "FWD", price: 5.5, teamId: 9, priorPointsPerGame: 6, priorExpectedGoals: 8, selectedBy: 20 });

  const fixtures = [
    makeFixture({ id: 1, event: 1, teamH: out.teamId, teamA: 900 }),
    makeFixture({ id: 2, event: 1, teamH: 9, teamA: 901, teamHDifficulty: 1, teamADifficulty: 5 }),
    makeFixture({ id: 3, event: 1, teamH: 902, teamA: 9, teamHDifficulty: 1, teamADifficulty: 5 }),
  ];
  const events = [{ id: 1, name: "Gameweek 1", deadline: new Date(Date.now() + 86400000).toISOString(), current: false, next: true, finished: false }];

  const data = {
    updatedAt: new Date().toISOString(),
    source: "test",
    seasonStatsThrough: 0,
    players: [...squad, candidate],
    fixtures,
    events,
    teams: [...new Set([...squad, candidate].map((p) => p.teamId))].map((id) => ({ id, name: `Team ${id}`, short: `T${id}` })),
    rules: makeRules(),
  };

  assert.equal(isValidSquad(squad, data as any), true, "test fixture squad must be a legal 15-player squad");

  const rows: Transfer[] = bestTransfers(data as any, squad, 5);
  const row = rows.find((r) => r.incoming.id === 500);
  assert.ok(row, "expected a transfer row recommending the double-gameweek candidate");
  assert.equal(row!.fixtureAdjustmentIn, 3, `fixture adjustment should average both legs (1 and 5 -> 3), got ${row!.fixtureAdjustmentIn}`);
});
