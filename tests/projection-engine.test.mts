import assert from "node:assert/strict";
import test from "node:test";
import {
  FplData,
  FplFixture,
  FplPlayer,
  attachIntegrityWarnings,
  findIdentityConflicts,
  isValidSquad,
  playerProjection,
  projectionMetrics,
} from "../app/lib/fpl.ts";
import { analysis, bestTransfers, Transfer } from "../app/components/CoachApp.tsx";

function makePlayer(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1, name: "Test", firstName: "Test", secondName: "Player", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: 3, position: "Midfielder", positionShort: "MID", price: 6, status: "a", chance: null,
    epNext: 2, form: 2, pointsPerGame: 3, priorPointsPerGame: 3, priorMinutes: 1500, priorStarts: 20,
    priorExpectedGoals: 3, priorExpectedAssists: 3, priorBonus: 10, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 100, totalPoints: 0, eventPoints: 0, selectedBy: 10, priceChange: 0, priceProjectionToday: 0,
    transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0,
    expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 0,
    starts: 0, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0,
    penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
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

test("regression: a near-zero-minutes player does not out-project an established elite midfielder", () => {
  // Mirrors the real Josh Dasilva anomaly: 2 prior minutes, 0.08 prior xG.
  const tinySample = makePlayer({ id: 103, price: 5, priorMinutes: 2, priorStarts: 0, priorExpectedGoals: 0.08, priorExpectedAssists: 0, priorPointsPerGame: 1, selectedBy: 0 });
  const elite = makePlayer({ id: 124, price: 5.5, priorMinutes: 1636, priorStarts: 18, priorExpectedGoals: 1.39, priorExpectedAssists: 3.95, priorBonus: 10, priorPointsPerGame: 4.1, selectedBy: 14.5 });
  const fixtures = [makeFixture({ event: 1, teamH: 1, teamA: 99 })];

  const tinyMetrics = projectionMetrics(tinySample, 1, fixtures, 1);
  const eliteMetrics = projectionMetrics({ ...elite, teamId: 1 }, 1, fixtures, 1);

  assert.ok(
    tinyMetrics.xPts < eliteMetrics.xPts,
    `a 2-minute-sample player (${tinyMetrics.xPts.toFixed(2)} xPts) must not outproject an established elite midfielder (${eliteMetrics.xPts.toFixed(2)} xPts)`,
  );
  assert.ok(
    tinyMetrics.xPts < 4,
    `2-minute-sample player projected ${tinyMetrics.xPts.toFixed(2)} xPts in one gameweek — per-90 rates must shrink toward a sane baseline, not extrapolate from a tiny sample`,
  );
});

test("reconciliation: every GW/3GW/5GW transfer delta returned by bestTransfers equals IN minus OUT exactly", () => {
  const out = makePlayer({ id: 2, positionId: 3, position: "Midfielder", positionShort: "MID", price: 5.5, teamId: 1, priorMinutes: 1636, priorStarts: 18, priorExpectedGoals: 1.39, priorExpectedAssists: 3.95, priorPointsPerGame: 4.1 });
  const gkps = [1, 2].map((n) => makePlayer({ id: n, positionId: 1, position: "Goalkeeper", positionShort: "GKP", price: 4.5, teamId: 100 + n }));
  const defs = [1, 2, 3, 4, 5].map((n) => makePlayer({ id: 10 + n, positionId: 2, position: "Defender", positionShort: "DEF", price: 4.5, teamId: 110 + n }));
  const mids = [out, ...[1, 2, 3, 4].map((n) => makePlayer({ id: 20 + n, positionId: 3, position: "Midfielder", positionShort: "MID", price: 5.0, teamId: 120 + n }))];
  const fwds = [1, 2, 3].map((n) => makePlayer({ id: 30 + n, positionId: 4, position: "Forward", positionShort: "FWD", price: 5.5, teamId: 130 + n }));
  const squad = [...gkps, ...defs, ...mids, ...fwds];
  assert.equal(squad.length, 15);

  const incoming = makePlayer({ id: 500, positionId: 3, position: "Midfielder", positionShort: "MID", price: 6.0, teamId: 6, priorMinutes: 2930, priorStarts: 33, priorExpectedGoals: 5.22, priorExpectedAssists: 5.95, priorPointsPerGame: 4.1, selectedBy: 10.7 });

  const fixtures = [1, 2, 3, 4, 5].flatMap((event) => [
    makeFixture({ id: event * 10 + 1, event, teamH: out.teamId, teamA: 900 }),
    makeFixture({ id: event * 10 + 2, event, teamH: incoming.teamId, teamA: 901 }),
  ]);
  const events = [
    { id: 1, name: "Gameweek 1", deadline: new Date(Date.now() + 86400000).toISOString(), current: false, next: true, finished: false },
    { id: 2, name: "Gameweek 2", deadline: new Date(Date.now() + 2 * 86400000).toISOString(), current: false, next: false, finished: false },
    { id: 3, name: "Gameweek 3", deadline: new Date(Date.now() + 3 * 86400000).toISOString(), current: false, next: false, finished: false },
    { id: 4, name: "Gameweek 4", deadline: new Date(Date.now() + 4 * 86400000).toISOString(), current: false, next: false, finished: false },
    { id: 5, name: "Gameweek 5", deadline: new Date(Date.now() + 5 * 86400000).toISOString(), current: false, next: false, finished: false },
  ];

  const data: FplData = {
    updatedAt: new Date().toISOString(),
    source: "test",
    seasonStatsThrough: 0,
    players: [...squad, incoming],
    fixtures,
    events,
    teams: [...new Set([...squad, incoming].map((p) => p.teamId))].map((id) => ({ id, name: `Team ${id}`, short: `T${id}` })),
    rules: makeRules(),
  };

  assert.equal(isValidSquad(squad, data), true, "test fixture squad must be a legal 15-player squad");

  const rows = bestTransfers(data, squad, 5);
  const row = rows.find((r: Transfer) => r.out.id === out.id && r.incoming.id === incoming.id);
  assert.ok(row, "expected the constructed OUT->IN transfer to appear among candidates");

  const eventIds = [1, 2, 3, 4, 5];
  const outByEvent = eventIds.map((e) => playerProjection(out, e, fixtures, 1));
  const inByEvent = eventIds.map((e) => playerProjection(incoming, e, fixtures, 1));

  assert.ok(Math.abs(row!.gain1 - (inByEvent[0] - outByEvent[0])) < 1e-9, "GW1 delta must equal IN GW1 minus OUT GW1 exactly");
  assert.ok(Math.abs(row!.gain3 - (inByEvent.slice(0, 3).reduce((a, b) => a + b, 0) - outByEvent.slice(0, 3).reduce((a, b) => a + b, 0))) < 1e-9, "3-GW delta must equal IN 3-GW minus OUT 3-GW exactly");
  assert.ok(Math.abs(row!.gain5 - (inByEvent.reduce((a, b) => a + b, 0) - outByEvent.reduce((a, b) => a + b, 0))) < 1e-9, "5-GW delta must equal IN 5-GW minus OUT 5-GW exactly");

  // Same underlying raw xPts metric on both sides — not weighted, not captain-doubled, not bench-discounted.
  assert.ok(Math.abs(row!.outGw1 - outByEvent[0]) < 1e-9);
  assert.ok(Math.abs(row!.inGw1 - inByEvent[0]) < 1e-9);
});

test("determinism: identical data produces identical projections across repeated calls", () => {
  const player = makePlayer({ id: 42, priorMinutes: 1200, priorStarts: 15, priorExpectedGoals: 4, priorExpectedAssists: 2 });
  const fixtures = [makeFixture({ event: 1, teamH: player.teamId, teamA: 2 })];
  const first = projectionMetrics(player, 1, fixtures, 1);
  const second = projectionMetrics(player, 1, fixtures, 1);
  assert.deepEqual(first, second, "calling projectionMetrics twice with identical inputs must yield byte-identical output");
});

test("identity integrity: clean data reports no conflicts, and a duplicate id with different teams is detected", () => {
  const clean = [makePlayer({ id: 1, teamId: 1 }), makePlayer({ id: 2, teamId: 2 })];
  assert.deepEqual(findIdentityConflicts(clean), []);

  const conflicting = [
    makePlayer({ id: 112, teamId: 6, positionId: 2, positionShort: "DEF" }),
    makePlayer({ id: 112, teamId: 19, positionId: 2, positionShort: "DEF" }),
  ];
  const conflicts = findIdentityConflicts(conflicting);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].issue, /conflicting teams/);
});

test("regression: bonus/DC/saves per-start rates shrink toward a baseline for a 1-start outlier sample, not just xG/xA", () => {
  // A single freak match (1 start) shouldn't set the season-long per-start rate at face value
  // for bonus, defensive contribution or saves either — same class of bug as the xG90 fix.
  const oneStartOutlierDef = makePlayer({ id: 200, positionShort: "DEF", positionId: 2, priorMinutes: 90, priorStarts: 1, priorBonus: 3, priorDefensiveContribution: 15, priorExpectedGoals: 0, priorExpectedAssists: 0 });
  const establishedDef = makePlayer({ id: 201, positionShort: "DEF", positionId: 2, priorMinutes: 3200, priorStarts: 36, priorBonus: 8, priorDefensiveContribution: 300, priorExpectedGoals: 0.5, priorExpectedAssists: 1 });
  const fixtures = [makeFixture({ event: 1, teamH: 1, teamA: 2 })];
  const outlier = projectionMetrics(oneStartOutlierDef, 1, fixtures, 1);
  const established = projectionMetrics({ ...establishedDef, teamId: 1 }, 1, fixtures, 1);
  assert.ok(
    outlier.xPts < established.xPts,
    `a 1-start outlier (bonus=3, DC=15 in that single match) must not outproject an established defender via unshrunk bonus/DC rates; got outlier=${outlier.xPts.toFixed(2)}, established=${established.xPts.toFixed(2)}`,
  );

  const oneStartGkp = makePlayer({ id: 210, positionShort: "GKP", positionId: 1, priorMinutes: 90, priorStarts: 1, priorSaves: 12, priorPenaltiesSaved: 1 });
  const gkpMetrics = projectionMetrics(oneStartGkp, 1, fixtures, 1);
  assert.ok(gkpMetrics.saves < 6, `a 1-start goalkeeper with 12 saves in that single match must not project ~12 saves/match going forward, got ${gkpMetrics.saves.toFixed(2)}`);
});

test("DC scoring is probability-weighted: a low-minutes player with a high per-start action rate does not get full linear credit", () => {
  // Mirrors the real Mosquera case: high mean actions/start (10.56) but low expected minutes (~30).
  const rotationRisk = makePlayer({ id: 11, positionShort: "DEF", positionId: 2, price: 5.5, priorMinutes: 986, priorStarts: 9, priorDefensiveContribution: 95, selectedBy: 6.9 });
  const fixtures = [makeFixture({ event: 1, teamH: rotationRisk.teamId, teamA: 2 })];
  const metrics = projectionMetrics(rotationRisk, 1, fixtures, 1);
  // Old linear formula gave clamp(95/9/10, 0, .9) * sixtyProb ~= 0.9 * ~0.2 = ~0.18-0.2.
  assert.ok(metrics.defensiveContribution < 0.15, `expected low-minutes player's DC credit to be discounted by probability of reaching the match threshold, got ${metrics.defensiveContribution.toFixed(3)}`);
});

test("regression: bench order always keeps the backup GK last, even when they outproject an outfield bench player", () => {
  // Reproduces the real Raya-vs-Gabriel case: a moderately-projected backup GK must never rank
  // above an outfield bench player, since a backup GK can only ever sub in for the starting GK.
  const starterGkp = makePlayer({ id: 1, positionShort: "GKP", positionId: 1, teamId: 1, priorMinutes: 3400, priorStarts: 38, priorSaves: 120, selectedBy: 20 });
  const backupGkp = makePlayer({ id: 2, positionShort: "GKP", positionId: 1, teamId: 2, priorMinutes: 1800, priorStarts: 20, priorSaves: 70, selectedBy: 3 });
  const defs = [1, 2, 3, 4].map((n) => makePlayer({ id: 10 + n, positionShort: "DEF", positionId: 2, teamId: 10 + n, priorMinutes: 3200, priorStarts: 36, priorExpectedGoals: 1, priorExpectedAssists: 1.5, priorDefensiveContribution: 200 }));
  const weakDef = makePlayer({ id: 15, positionShort: "DEF", positionId: 2, teamId: 15, priorMinutes: 0, priorStarts: 0, selectedBy: 0 }); // near-zero projection, should out-rank nobody
  const mids = [1, 2, 3, 4, 5].map((n) => makePlayer({ id: 20 + n, positionShort: "MID", positionId: 3, teamId: 20 + n, priorMinutes: 2800, priorStarts: 32, priorExpectedGoals: 4, priorExpectedAssists: 4 }));
  const fwds = [1, 2, 3].map((n) => makePlayer({ id: 30 + n, positionShort: "FWD", positionId: 4, teamId: 30 + n, priorMinutes: 2600, priorStarts: 30, priorExpectedGoals: 8, priorExpectedAssists: 2 }));
  const squad = [starterGkp, backupGkp, ...defs, weakDef, ...mids, ...fwds];
  assert.equal(squad.length, 15);

  const fixtures = squad.map((p) => makeFixture({ id: p.teamId, event: 1, teamH: p.teamId, teamA: 900 + p.teamId }));
  const events = [{ id: 1, name: "Gameweek 1", deadline: new Date(Date.now() + 86400000).toISOString(), current: false, next: true, finished: false }];
  const data: FplData = {
    updatedAt: new Date().toISOString(), source: "test", seasonStatsThrough: 0,
    players: squad, fixtures, events,
    teams: squad.map((p) => ({ id: p.teamId, name: `Team ${p.teamId}`, short: `T${p.teamId}` })),
    rules: makeRules(),
  };

  assert.equal(isValidSquad(squad, data), true, "test fixture squad must be a legal 15-player squad");
  const a = analysis(data, squad)!;
  assert.ok(a, "analysis() must return a result for a valid squad");
  assert.equal(a.bench[a.bench.length - 1].positionShort, "GKP", "the backup GK must always be the last bench entry, regardless of raw xPts");
  // Confirm this isn't vacuous: the backup GK's xPts must genuinely exceed the weakest outfield
  // bench player's, so the GK-last guard is doing real work, not just matching a lucky ordering.
  const gkXpts = playerProjection(backupGkp, 1, fixtures, 1);
  const outfieldBenchXpts = a.bench.filter((p) => p.positionShort !== "GKP").map((p) => playerProjection(p, 1, fixtures, 1));
  assert.ok(outfieldBenchXpts.some((x) => x < gkXpts), "test setup should produce a backup GK who out-projects at least one outfield bench player, otherwise this test doesn't exercise the guard");
});

test("identity-warning wiring: attachIntegrityWarnings (the exact function the API route calls) surfaces conflicts, and is silent on clean data", () => {
  const clean = { players: [makePlayer({ id: 1, teamId: 1 }), makePlayer({ id: 2, teamId: 2 })] };
  const cleanResult = attachIntegrityWarnings(clean);
  assert.deepEqual(cleanResult.dataIntegrityWarnings, []);

  const conflicting = {
    players: [
      makePlayer({ id: 112, teamId: 6, positionId: 2, positionShort: "DEF" }),
      makePlayer({ id: 112, teamId: 19, positionId: 2, positionShort: "DEF" }),
    ],
  };
  const conflictResult = attachIntegrityWarnings(conflicting);
  assert.equal(conflictResult.dataIntegrityWarnings.length, 1);
  assert.match(conflictResult.dataIntegrityWarnings[0], /conflicting teams/);
});
