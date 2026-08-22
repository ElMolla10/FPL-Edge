import assert from "node:assert/strict";
import test from "node:test";
import { FplEvent, FplFixture, FplPlayer, isValidSquad, projectionMetrics } from "../app/lib/fpl.ts";
import { ChipHorizonRow, Transfer, bestTransfers, chipVerdictAcrossHorizon, opponent, transferHoldNote } from "../app/components/CoachApp.tsx";
import { ChipScores } from "../app/components/LiveIntelligence.tsx";
import { DoubleGameweek, detectFixtureAnomalies, nearestInHorizon } from "../app/lib/dgw.ts";

function makePlayer(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1, name: "Peak Forward", firstName: "Peak", secondName: "Forward", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: 4, position: "Forward", positionShort: "FWD", price: 15, status: "a", chance: null,
    epNext: 9, form: 9, pointsPerGame: 10, priorPointsPerGame: 10, priorMinutes: 3400, priorStarts: 37,
    priorExpectedGoals: 42, priorExpectedAssists: 8, priorBonus: 34, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 0, totalPoints: 0, eventPoints: 0, selectedBy: 55, priceChange: 0, priceProjectionToday: 0,
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

function makeEvent(overrides: Partial<FplEvent> = {}): FplEvent {
  return {
    id: 1, name: "Gameweek 1", deadline: new Date(Date.now() + 86400000).toISOString(),
    current: false, next: false, finished: false,
    ...overrides,
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

// --- detectFixtureAnomalies: doubles, blanks, pending (event: null) fixtures ---

test("detectFixtureAnomalies: a fully-scheduled season (today's real fixture list) finds nothing", () => {
  // Every team plays exactly once per event -- the actual shape of the live 2026/27 fixture list
  // right now (verified directly against the official feed: 380/380 fixtures, 0 doubles, 0 blanks).
  const events = [makeEvent({ id: 1 }), makeEvent({ id: 2 })];
  const fixtures = [
    makeFixture({ id: 1, event: 1, teamH: 1, teamA: 2 }),
    makeFixture({ id: 2, event: 1, teamH: 3, teamA: 4 }),
    makeFixture({ id: 3, event: 2, teamH: 1, teamA: 3 }),
    makeFixture({ id: 4, event: 2, teamH: 2, teamA: 4 }),
  ];
  const data = { events, fixtures, teams: [{ id: 1, name: "A", short: "A" }, { id: 2, name: "B", short: "B" }, { id: 3, name: "C", short: "C" }, { id: 4, name: "D", short: "D" }] } as any;
  const result = detectFixtureAnomalies(data);
  assert.deepEqual(result.doubles, []);
  assert.deepEqual(result.blanks, []);
  assert.deepEqual(result.pending, []);
});

test("detectFixtureAnomalies: a team with two fixtures in one event is flagged as a double, with both fixture ids", () => {
  const events = [makeEvent({ id: 1 })];
  const fixtures = [
    makeFixture({ id: 10, event: 1, teamH: 1, teamA: 2 }),
    makeFixture({ id: 11, event: 1, teamH: 3, teamA: 1 }),
  ];
  const data = { events, fixtures, teams: [{ id: 1, name: "A", short: "A" }, { id: 2, name: "B", short: "B" }, { id: 3, name: "C", short: "C" }] } as any;
  const result = detectFixtureAnomalies(data);
  assert.equal(result.doubles.length, 1);
  assert.equal(result.doubles[0].teamId, 1);
  assert.equal(result.doubles[0].eventId, 1);
  assert.deepEqual([...result.doubles[0].fixtureIds].sort(), [10, 11]);
});

test("detectFixtureAnomalies: a team missing from an unfinished event's fixtures is flagged as a blank", () => {
  const events = [makeEvent({ id: 1, finished: false })];
  // Team 2 has no fixture at all in event 1.
  const fixtures = [makeFixture({ id: 1, event: 1, teamH: 1, teamA: 3 })];
  const data = { events, fixtures, teams: [{ id: 1, name: "A", short: "A" }, { id: 2, name: "B", short: "B" }, { id: 3, name: "C", short: "C" }] } as any;
  const result = detectFixtureAnomalies(data);
  assert.ok(result.blanks.some((b) => b.teamId === 2 && b.eventId === 1), "team 2 should be flagged blank in event 1");
});

test("detectFixtureAnomalies: a finished event is never reported as blank, even if a team has no fixture in it", () => {
  const events = [makeEvent({ id: 1, finished: true })];
  const fixtures = [makeFixture({ id: 1, event: 1, teamH: 1, teamA: 3 })];
  const data = { events, fixtures, teams: [{ id: 1, name: "A", short: "A" }, { id: 2, name: "B", short: "B" }, { id: 3, name: "C", short: "C" }] } as any;
  const result = detectFixtureAnomalies(data);
  assert.deepEqual(result.blanks, [], "a finished gameweek should never be flagged -- there's nothing left to plan around");
});

test("detectFixtureAnomalies: a fixture with event: null is reported as pending, and excluded from doubles/blanks", () => {
  const events = [makeEvent({ id: 1 })];
  const fixtures = [
    makeFixture({ id: 1, event: 1, teamH: 1, teamA: 2 }),
    makeFixture({ id: 2, event: null, teamH: 3, teamA: 1 }),
  ];
  const data = { events, fixtures, teams: [{ id: 1, name: "A", short: "A" }, { id: 2, name: "B", short: "B" }, { id: 3, name: "C", short: "C" }] } as any;
  const result = detectFixtureAnomalies(data);
  assert.equal(result.pending.length, 1);
  assert.deepEqual(result.pending[0], { fixtureId: 2, teamH: 3, teamA: 1 });
  // Team 1 still has its normal event-1 fixture, so it must not also show up as a double just
  // because a second, unrelated, not-yet-scheduled fixture involving it exists.
  assert.deepEqual(result.doubles, []);
});

test("detectFixtureAnomalies: multiple teams can each be flagged as a double in the same event", () => {
  const events = [makeEvent({ id: 1 })];
  const fixtures = [
    makeFixture({ id: 1, event: 1, teamH: 1, teamA: 2 }),
    makeFixture({ id: 2, event: 1, teamH: 1, teamA: 3 }),
    makeFixture({ id: 3, event: 1, teamH: 2, teamA: 4 }),
  ];
  const data = { events, fixtures, teams: [{ id: 1, name: "A", short: "A" }, { id: 2, name: "B", short: "B" }, { id: 3, name: "C", short: "C" }, { id: 4, name: "D", short: "D" }] } as any;
  const result = detectFixtureAnomalies(data);
  const teamIds = result.doubles.map((d) => d.teamId).sort();
  assert.deepEqual(teamIds, [1, 2], "both team 1 (2 fixtures) and team 2 (2 fixtures) should be flagged");
});

// --- nearestInHorizon: the shared "soonest anomaly in a forward window" helper ---

test("nearestInHorizon: no items fall inside the horizon -- returns empty", () => {
  const result = nearestInHorizon([{ eventId: 20 }], [1, 2, 3]);
  assert.deepEqual(result, []);
});

test("nearestInHorizon: returns only the items at the nearest eventId, not every item in horizon", () => {
  const items = [{ eventId: 5, tag: "far" }, { eventId: 2, tag: "near-a" }, { eventId: 2, tag: "near-b" }, { eventId: 3, tag: "mid" }];
  const result = nearestInHorizon(items, [1, 2, 3, 4, 5]);
  assert.deepEqual(result.map((r) => r.tag).sort(), ["near-a", "near-b"]);
});

// --- transferHoldNote: only fires when rolling is already the recommendation ---

test("transferHoldNote: no note when a transfer is actually recommended (not rolling)", () => {
  const doubles: DoubleGameweek[] = [{ eventId: 24, teamId: 1, fixtureIds: [1, 2] }];
  assert.equal(transferHoldNote(doubles, false), null);
});

test("transferHoldNote: no note when rolling but no double is within the horizon", () => {
  assert.equal(transferHoldNote([], true), null);
});

test("transferHoldNote: fires when rolling and a double is within the horizon, naming the event and team count", () => {
  const doubles: DoubleGameweek[] = [
    { eventId: 24, teamId: 1, fixtureIds: [1, 2] },
    { eventId: 24, teamId: 5, fixtureIds: [3, 4] },
  ];
  const note = transferHoldNote(doubles, true);
  assert.ok(note?.includes("GW24"), `expected the note to mention GW24, got: ${note}`);
  assert.ok(note?.includes("2 teams"), `expected the note to mention 2 teams, got: ${note}`);
});

// --- chipVerdictAcrossHorizon: PLAY only when nothing better is coming soon ---

function makeChipScores(overrides: Partial<Record<keyof ChipScores, number>> = {}): ChipScores {
  const score = (k: keyof ChipScores) => overrides[k] ?? 3;
  return {
    wildcard: { score: score("wildcard"), detail: "wc" },
    freeHit: { score: score("freeHit"), detail: "fh" },
    benchBoost: { score: score("benchBoost"), detail: "bb" },
    tripleCaptain: { score: score("tripleCaptain"), detail: "tc" },
  };
}

test("chipVerdictAcrossHorizon: empty rows -- SAVE, not ready, no data", () => {
  const result = chipVerdictAcrossHorizon([]);
  assert.equal(result.ready, false);
  assert.equal(result.label, "SAVE");
});

test("chipVerdictAcrossHorizon: current week clears 8/10 and nothing better is coming -- ready to play", () => {
  const rows: ChipHorizonRow[] = [
    { eventId: 1, scores: makeChipScores({ benchBoost: 9 }) },
    { eventId: 2, scores: makeChipScores({ benchBoost: 4 }) },
  ];
  const result = chipVerdictAcrossHorizon(rows);
  assert.equal(result.ready, true);
  assert.equal(result.label, "BENCH BOOST");
});

test("chipVerdictAcrossHorizon: current week does not clear 8/10 -- SAVE", () => {
  const rows: ChipHorizonRow[] = [{ eventId: 1, scores: makeChipScores({ benchBoost: 6 }) }];
  const result = chipVerdictAcrossHorizon(rows);
  assert.equal(result.ready, false);
  assert.equal(result.label, "SAVE");
});

test("chipVerdictAcrossHorizon: current week clears 8/10 but a later week clears it by a real margin for the SAME chip -- SAVE, names the better window", () => {
  const rows: ChipHorizonRow[] = [
    { eventId: 1, scores: makeChipScores({ benchBoost: 8 }) },
    { eventId: 2, scores: makeChipScores({ benchBoost: 8.5 }) }, // within the +1 margin -- not "meaningfully" better
    { eventId: 3, scores: makeChipScores({ benchBoost: 10 }) }, // clears the margin
  ];
  const result = chipVerdictAcrossHorizon(rows);
  assert.equal(result.ready, false);
  assert.equal(result.label, "SAVE");
  assert.ok(result.detail.includes("GW3"), `expected the detail to name GW3 as the better window, got: ${result.detail}`);
});

test("chipVerdictAcrossHorizon: a later week scoring higher for a DIFFERENT chip does not override this week's best chip", () => {
  const rows: ChipHorizonRow[] = [
    { eventId: 1, scores: makeChipScores({ benchBoost: 9 }) }, // this week's best chip is Bench Boost
    { eventId: 2, scores: makeChipScores({ tripleCaptain: 10 }) }, // later week is great for a DIFFERENT chip
  ];
  const result = chipVerdictAcrossHorizon(rows);
  assert.equal(result.ready, true, "a stronger later week for an unrelated chip must not block this week's own best chip");
  assert.equal(result.label, "BENCH BOOST");
});
