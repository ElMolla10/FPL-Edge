import assert from "node:assert/strict";
import test from "node:test";
import { FplFixture, FplPlayer, bestXi } from "../app/lib/fpl.ts";
import { HistoryWeek, LockRecord, resolveBenchDisplay, resolveCurrentXi, resolvePastGameweek } from "../app/components/CoachApp.tsx";

function makePlayer(overrides: Partial<FplPlayer> & { id: number; name: string }): FplPlayer {
  return {
    firstName: overrides.name, secondName: "", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: 4, position: "Forward", positionShort: "FWD", price: 8, status: "a", chance: null,
    epNext: 5, form: 5, pointsPerGame: 5, priorPointsPerGame: 5, priorMinutes: 2000, priorStarts: 25,
    priorExpectedGoals: 10, priorExpectedAssists: 3, priorBonus: 15, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 0, totalPoints: 0, eventPoints: 0, eventMinutes: 0, selectedBy: 20, priceChange: 0, priceProjectionToday: 0,
    transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0,
    expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 0,
    starts: 0, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0,
    penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
    ...overrides,
  };
}

const players = [
  makePlayer({ id: 1, name: "Keeper", positionShort: "GKP" }),
  makePlayer({ id: 2, name: "Defender", positionShort: "DEF" }),
  makePlayer({ id: 3, name: "Midfielder", positionShort: "MID" }),
  makePlayer({ id: 4, name: "Forward1", positionShort: "FWD" }),
  makePlayer({ id: 5, name: "BenchPlayer", positionShort: "MID" }),
  makePlayer({ id: 6, name: "SubOn", positionShort: "MID" }),
];

function makeFixture(overrides: Partial<FplFixture> = {}): FplFixture {
  return {
    id: 1, event: 1, teamH: 1, teamA: 2, teamHDifficulty: 3, teamADifficulty: 3,
    finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null,
    ...overrides,
  };
}

// A 15-man squad (2 GKP, 5 DEF, 5 MID, 3 FWD) where DEF id 7 is drastically weaker than the other
// four defenders on every stat that feeds projectionMetrics -- strong enough that bestXi() should
// reliably exclude it from its own pick, so a lock that starts it anyway is a genuine, provable
// divergence from the model, not a coincidence.
const strongDef = { priorMinutes: 3000, priorStarts: 34, priorExpectedGoals: 3, priorExpectedAssists: 4, priorBonus: 12, form: 6, pointsPerGame: 6, epNext: 6, minutes: 500, starts: 5 };
const weakDef = { priorMinutes: 90, priorStarts: 1, priorExpectedGoals: 0, priorExpectedAssists: 0, priorBonus: 0, form: 0.5, pointsPerGame: 0.5, epNext: 0.5, minutes: 0, starts: 0 };
const lockSquad = [
  makePlayer({ id: 101, name: "GK1", positionShort: "GKP", ...strongDef }),
  makePlayer({ id: 102, name: "GK2", positionShort: "GKP", ...weakDef }),
  makePlayer({ id: 3, name: "DEF3", positionShort: "DEF", ...strongDef }),
  makePlayer({ id: 4, name: "DEF4", positionShort: "DEF", ...strongDef }),
  makePlayer({ id: 5, name: "DEF5", positionShort: "DEF", ...strongDef }),
  makePlayer({ id: 6, name: "DEF6", positionShort: "DEF", ...strongDef }),
  makePlayer({ id: 7, name: "DEF7Weak", positionShort: "DEF", ...weakDef }),
  makePlayer({ id: 108, name: "MID8", positionShort: "MID", ...strongDef }),
  makePlayer({ id: 109, name: "MID9", positionShort: "MID", ...strongDef }),
  makePlayer({ id: 110, name: "MID10", positionShort: "MID", ...strongDef }),
  makePlayer({ id: 111, name: "MID11", positionShort: "MID", ...strongDef }),
  makePlayer({ id: 112, name: "MID12", positionShort: "MID", ...weakDef }),
  makePlayer({ id: 113, name: "FWD13", positionShort: "FWD", ...strongDef }),
  makePlayer({ id: 114, name: "FWD14", positionShort: "FWD", ...strongDef }),
  makePlayer({ id: 115, name: "FWD15", positionShort: "FWD", ...weakDef }),
];
const lockFixtures = [...new Set(lockSquad.map((p) => p.teamId))].map((teamId) =>
  makeFixture({ id: teamId, event: 1, teamH: teamId, teamA: 900 + teamId }),
);

test("resolveCurrentXi: a locked XI is used verbatim even when it differs from what bestXi() would currently pick", () => {
  const modelPick = bestXi(lockSquad, 1, lockFixtures, 1);
  // Confirm the divergence is real before asserting on it -- the model must NOT have picked the
  // weak defender on its own, otherwise this wouldn't prove the lock is what drove the result.
  assert.ok(!modelPick.players.some((p) => p.id === 7), "sanity check: bestXi should not pick the weak defender on its own");

  const lock: LockRecord = {
    event: 1, lockedAt: new Date().toISOString(), dataUpdatedAt: new Date().toISOString(),
    predicted: 40, squadIds: lockSquad.map((p) => p.id),
    // Deliberately starts the weak defender (id 7) in place of a strong one (id 6) -- a real
    // manager's actual locked choice, not the model's preference.
    xiIds: [101, 3, 4, 5, 7, 108, 109, 110, 111, 113, 114],
    captainId: 108, viceId: 109,
  };

  const resolution = resolveCurrentXi(lockSquad, lockSquad, 1, lockFixtures, lock);

  assert.equal(resolution.source, "locked");
  assert.ok(resolution.xi.some((p) => p.id === 7), "the locked weak defender must appear in the Current view's XI");
  assert.ok(!resolution.xi.some((p) => p.id === 6), "the model-preferred defender that was NOT locked in must not appear");
  assert.deepEqual(resolution.xi.map((p) => p.id).sort(), lock.xiIds.slice().sort());
  assert.equal(resolution.modelCaptain?.id, 108);
  assert.equal(resolution.modelVice?.id, 109);
});

test("resolveCurrentXi: falls back to bestXi() when no lock exists for this event", () => {
  const modelPick = bestXi(lockSquad, 1, lockFixtures, 1);

  const resolution = resolveCurrentXi(lockSquad, lockSquad, 1, lockFixtures, undefined);

  assert.equal(resolution.source, "model");
  assert.deepEqual(resolution.xi.map((p) => p.id).sort(), modelPick.players.map((p) => p.id).sort());
  assert.ok(!resolution.xi.some((p) => p.id === 7), "without a lock, the weak defender should not be selected");
});

test("resolveBenchDisplay: no autosub (effectiveXi === xi) -- returns exactly the original bench, unchanged", () => {
  const xi = [makePlayer({ id: 1, name: "Starter1" }), makePlayer({ id: 2, name: "Starter2" })];
  const bench = [makePlayer({ id: 3, name: "Bench1" }), makePlayer({ id: 4, name: "Bench2" })];

  const result = resolveBenchDisplay(bench, xi, xi);

  assert.deepEqual(result.map((p) => p.id), [3, 4]);
});

test("resolveBenchDisplay: a bench player promoted into effectiveXi drops out of the bench list", () => {
  const promoted = makePlayer({ id: 3, name: "Bench1" });
  const xi = [makePlayer({ id: 1, name: "Starter1" }), makePlayer({ id: 2, name: "Starter2" })];
  const bench = [promoted, makePlayer({ id: 4, name: "Bench2" })];
  const effectiveXi = [makePlayer({ id: 1, name: "Starter1" }), promoted]; // Starter2 (id 2) subbed out, Bench1 (id 3) subbed in

  const result = resolveBenchDisplay(bench, xi, effectiveXi);

  assert.ok(!result.some((p) => p.id === 3), "the promoted player must not appear twice (pitch + bench)");
});

test("resolveBenchDisplay: the displaced starter appears on the bench instead of vanishing", () => {
  const promoted = makePlayer({ id: 3, name: "Bench1" });
  const displacedStarter = makePlayer({ id: 2, name: "Starter2" });
  const xi = [makePlayer({ id: 1, name: "Starter1" }), displacedStarter];
  const bench = [promoted, makePlayer({ id: 4, name: "Bench2" })];
  const effectiveXi = [makePlayer({ id: 1, name: "Starter1" }), promoted];

  const result = resolveBenchDisplay(bench, xi, effectiveXi);

  assert.ok(result.some((p) => p.id === 2), "Starter2 (subbed out) must appear on the bench, not disappear entirely");
  assert.deepEqual(result.map((p) => p.id).sort(), [2, 4]);
});

test("resolvePastGameweek: official history data with a full squad -- reconstructs XI/bench with real points, source 'official'", () => {
  const historyWeek: HistoryWeek = {
    event: 3,
    points: 62,
    squad: [
      { elementId: 1, position: 1, multiplier: 1, isCaptain: false, isViceCaptain: false, elementType: 1 },
      { elementId: 2, position: 2, multiplier: 1, isCaptain: false, isViceCaptain: false, elementType: 2 },
      { elementId: 3, position: 3, multiplier: 2, isCaptain: true, isViceCaptain: false, elementType: 3 },
      { elementId: 4, position: 4, multiplier: 1, isCaptain: false, isViceCaptain: true, elementType: 4 },
      { elementId: 5, position: 12, multiplier: 0, isCaptain: false, isViceCaptain: false, elementType: 3 },
    ],
    playerPoints: { "1": 6, "2": 2, "3": 11, "4": 8, "5": 1 },
    automaticSubs: [],
  };

  const result = resolvePastGameweek(players, historyWeek, undefined);

  assert.ok(result);
  assert.equal(result!.source, "official");
  assert.equal(result!.totalPoints, 62);
  assert.equal(result!.predictedPoints, null);
  assert.equal(result!.xi.length, 4);
  assert.equal(result!.bench.length, 1);
  assert.equal(result!.bench[0].player.id, 5);
  const captainRow = result!.xi.find((r) => r.player.id === 3);
  assert.equal(captainRow?.isCaptain, true);
  assert.equal(captainRow?.multiplier, 2);
  assert.equal(captainRow?.points, 11);
});

test("resolvePastGameweek: official data includes automatic subs -- maps element ids to player names", () => {
  const historyWeek: HistoryWeek = {
    event: 3,
    points: 40,
    squad: [
      { elementId: 1, position: 1, multiplier: 1, isCaptain: false, isViceCaptain: false, elementType: 1 },
    ],
    playerPoints: { "1": 6 },
    automaticSubs: [{ elementIn: 6, elementOut: 4 }],
  };

  const result = resolvePastGameweek(players, historyWeek, undefined);

  assert.ok(result);
  assert.deepEqual(result!.automaticSubs, [{ inName: "SubOn", outName: "Forward1" }]);
});

test("resolvePastGameweek: an automatic sub moves the subbed-in player into the displayed XI and the subbed-out player onto the bench, not just a footnote", () => {
  const historyWeek: HistoryWeek = {
    event: 3,
    points: 55,
    squad: [
      { elementId: 1, position: 1, multiplier: 1, isCaptain: false, isViceCaptain: false, elementType: 1 },
      { elementId: 2, position: 2, multiplier: 1, isCaptain: false, isViceCaptain: false, elementType: 2 },
      { elementId: 3, position: 3, multiplier: 1, isCaptain: false, isViceCaptain: false, elementType: 3 },
      { elementId: 4, position: 4, multiplier: 1, isCaptain: false, isViceCaptain: false, elementType: 4 },
      { elementId: 5, position: 12, multiplier: 0, isCaptain: false, isViceCaptain: false, elementType: 3 },
      { elementId: 6, position: 13, multiplier: 0, isCaptain: false, isViceCaptain: false, elementType: 3 },
    ],
    playerPoints: { "1": 6, "2": 2, "3": 5, "4": 0, "5": 1, "6": 9 },
    automaticSubs: [{ elementIn: 6, elementOut: 4 }],
  };

  const result = resolvePastGameweek(players, historyWeek, undefined);

  assert.ok(result);
  assert.ok(result!.xi.some((r) => r.player.id === 6), "SubOn (came on) should now be in the displayed XI");
  assert.ok(!result!.xi.some((r) => r.player.id === 4), "Forward1 (subbed out, 0 minutes) should no longer be in the displayed XI");
  assert.ok(result!.bench.some((r) => r.player.id === 4), "Forward1 should now be on the displayed bench");
  assert.ok(!result!.bench.some((r) => r.player.id === 6), "SubOn should no longer be on the displayed bench");
  const subOnRow = result!.xi.find((r) => r.player.id === 6);
  assert.equal(subOnRow?.points, 9, "the moved player's real points should carry over, not reset");
});

test("resolvePastGameweek: history fetch failed for this week (unavailable) -- falls through to no data (no lock present)", () => {
  const historyWeek: HistoryWeek = { event: 3, points: 0, unavailable: true };

  const result = resolvePastGameweek(players, historyWeek, undefined);

  assert.equal(result, null);
});

test("resolvePastGameweek: no history at all, but a lock record exists -- source 'locked-prediction', actual points stay null", () => {
  const lock: LockRecord = {
    event: 3, lockedAt: new Date().toISOString(), dataUpdatedAt: new Date().toISOString(),
    predicted: 54.2, squadIds: [1, 2, 3, 4, 5], xiIds: [1, 2, 3, 4], captainId: 3, viceId: 4,
  };

  const result = resolvePastGameweek(players, undefined, lock);

  assert.ok(result);
  assert.equal(result!.source, "locked-prediction");
  assert.equal(result!.totalPoints, null);
  assert.equal(result!.predictedPoints, 54.2);
  assert.equal(result!.xi.length, 4);
  assert.equal(result!.bench.length, 1);
  assert.equal(result!.bench[0].player.id, 5);
  const captainRow = result!.xi.find((r) => r.player.id === 3);
  assert.equal(captainRow?.isCaptain, true);
  assert.equal(captainRow?.multiplier, 2);
  // Locked-prediction rows never fabricate a real score -- only official history data has real points.
  assert.equal(captainRow?.points, 0);
});

test("resolvePastGameweek: neither official history nor a lock record exists -- null, caller shows 'no snapshot recorded'", () => {
  const result = resolvePastGameweek(players, undefined, undefined);

  assert.equal(result, null);
});

test("resolvePastGameweek: official history is preferred over a lock record when both exist for the same week", () => {
  const historyWeek: HistoryWeek = {
    event: 3, points: 71,
    squad: [{ elementId: 1, position: 1, multiplier: 1, isCaptain: false, isViceCaptain: false, elementType: 1 }],
    playerPoints: { "1": 9 },
  };
  const lock: LockRecord = {
    event: 3, lockedAt: new Date().toISOString(), dataUpdatedAt: new Date().toISOString(),
    predicted: 40, squadIds: [1], xiIds: [1], captainId: 1, viceId: 1,
  };

  const result = resolvePastGameweek(players, historyWeek, lock);

  assert.equal(result?.source, "official");
  assert.equal(result?.totalPoints, 71);
});
