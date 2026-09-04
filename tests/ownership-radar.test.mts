import assert from "node:assert/strict";
import test from "node:test";
import { FplData, FplFixture, FplPlayer } from "../app/lib/fpl.ts";
import { rawDifferentialsByPosition, templateByPosition } from "../app/lib/ownership-radar.ts";

function makePlayer(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1, name: "Player", firstName: "Player", secondName: "One", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: 3, position: "Midfielder", positionShort: "MID", price: 6, status: "a", chance: null,
    epNext: 3, form: 3, pointsPerGame: 3, priorPointsPerGame: 3, priorMinutes: 2500, priorStarts: 30,
    priorExpectedGoals: 3, priorExpectedAssists: 3, priorBonus: 10, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 100, totalPoints: 0, eventPoints: 0, eventMinutes: 0, eventBonus: 0, eventDefensiveContribution: 0,
    selectedBy: 10, priceChange: 0, priceProjectionToday: 0, priceChangeSinceStart: 0, priceOutlook: [],
    transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0,
    expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 0,
    starts: 0, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0,
    penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
    ...overrides,
  };
}

const positions: FplData["rules"]["positions"] = [
  { id: 1, name: "Goalkeeper", short: "GKP", squad: 2, minPlay: 1, maxPlay: 1 },
  { id: 2, name: "Defender", short: "DEF", squad: 5, minPlay: 3, maxPlay: 5 },
  { id: 3, name: "Midfielder", short: "MID", squad: 5, minPlay: 2, maxPlay: 5 },
  { id: 4, name: "Forward", short: "FWD", squad: 3, minPlay: 1, maxPlay: 3 },
];

// A single real fixture so playerProjection's underlying model actually differentiates players by
// their attributes (with zero fixtures, games.length===0 forces xPts to 0 for every player
// unconditionally -- fine for tests that only care about grouping/cardinality, not for the
// ranking-behavior test below, which needs real, distinct xPts values).
const fixtures: FplFixture[] = [
  { id: 1, event: 1, teamH: 1, teamA: 2, teamHDifficulty: 3, teamADifficulty: 3, finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null },
];

// --- templateByPosition ---

test("templateByPosition: groups strictly by positionId -- a DEF player never appears in the MID group", () => {
  const def = makePlayer({ id: 1, positionId: 2, positionShort: "DEF", selectedBy: 50 });
  const mid = makePlayer({ id: 2, positionId: 3, positionShort: "MID", selectedBy: 50 });
  const result = templateByPosition([def, mid], positions);
  const midGroup = result.find(g => g.position.id === 3)!;
  assert.deepEqual(midGroup.players.map(p => p.id), [2]);
  const defGroup = result.find(g => g.position.id === 2)!;
  assert.deepEqual(defGroup.players.map(p => p.id), [1]);
});

test("templateByPosition: sorts descending by real selectedBy%", () => {
  const players = [
    makePlayer({ id: 1, positionId: 3, selectedBy: 20 }),
    makePlayer({ id: 2, positionId: 3, selectedBy: 60 }),
    makePlayer({ id: 3, positionId: 3, selectedBy: 40 }),
  ];
  const result = templateByPosition(players, positions);
  const mid = result.find(g => g.position.id === 3)!;
  assert.deepEqual(mid.players.map(p => p.id), [2, 3, 1]);
});

test("templateByPosition: caps each position at its OWN real rule.squad count, not a fixed display number", () => {
  const players = Array.from({ length: 4 }, (_, i) => makePlayer({ id: i + 1, positionId: 1, positionShort: "GKP", selectedBy: 10 - i }));
  const result = templateByPosition(players, positions);
  const gkp = result.find(g => g.position.id === 1)!;
  assert.equal(gkp.players.length, 2, "GKP's real squad count is 2 -- must not show more");
  assert.deepEqual(gkp.players.map(p => p.id), [1, 2]);
});

test("templateByPosition: ties on selectedBy break by id ascending, for render stability", () => {
  const players = [
    makePlayer({ id: 5, positionId: 4, positionShort: "FWD", selectedBy: 30 }),
    makePlayer({ id: 2, positionId: 4, positionShort: "FWD", selectedBy: 30 }),
    makePlayer({ id: 8, positionId: 4, positionShort: "FWD", selectedBy: 30 }),
  ];
  const result = templateByPosition(players, positions);
  const fwd = result.find(g => g.position.id === 4)!;
  assert.deepEqual(fwd.players.map(p => p.id), [2, 5, 8]);
});

test("templateByPosition: no players fetched for a position -- empty array, not a crash", () => {
  const result = templateByPosition([], positions);
  assert.equal(result.length, 4);
  assert.ok(result.every(g => g.players.length === 0));
});

// --- rawDifferentialsByPosition ---

test("rawDifferentialsByPosition: groups strictly by positionId", () => {
  const def = makePlayer({ id: 1, positionId: 2, positionShort: "DEF", selectedBy: 5, epNext: 5 });
  const mid = makePlayer({ id: 2, positionId: 3, positionShort: "MID", selectedBy: 5, epNext: 5 });
  const result = rawDifferentialsByPosition([def, mid], positions, fixtures, [1]);
  const midGroup = result.find(g => g.position.id === 3)!;
  assert.deepEqual(midGroup.players.map(p => p.player.id), [2]);
});

// The core claim this function exists to prove, and the one that caught a real bug during design:
// a first attempt ranked by the ratio xPts5/max(0.1, selectedBy), which turned out to be badly
// scale-mismatched (real selectedBy spans roughly 0-60, a real 5-GW xPts total spans roughly
// 0-40) -- confirmed live against the real projection engine that a 0.5%-owned player with a
// mediocre projection (xPts≈2.5) scored HIGHER under that ratio than an 18%-owned player with a
// genuinely large projection edge (xPts≈3.9), which is backwards. The shipped combined-rank
// approach (projRank + ownRank, both pure ordinal positions among the position's own real player
// pool) fixes this: every value below is a real playerProjection output over the real fixture
// above, not fabricated. B is meaningfully owned (8%, not the pool's lowest) but has by far the
// best real projection in the pool; it must rank ABOVE A, which is barely owned (0.5%, the pool's
// lowest) but has a negligible projection -- proving ownership alone doesn't decide the order.
test("rawDifferentialsByPosition: a moderately-owned high-upside player outranks a barely-owned negligible one -- not a plain ownership-ascending sort", () => {
  const players = [
    makePlayer({ id: 1, positionId: 3, selectedBy: 0.5, epNext: 0.5 }), // A: lowest owned, weakest real projection
    makePlayer({ id: 2, positionId: 3, selectedBy: 8, epNext: 20 }), // B: moderately owned, strongest real projection
    makePlayer({ id: 3, positionId: 3, selectedBy: 2, epNext: 3 }), // filler
    makePlayer({ id: 4, positionId: 3, selectedBy: 18, epNext: 1 }), // filler
    makePlayer({ id: 5, positionId: 3, selectedBy: 25, epNext: 0.4 }), // filler, highest owned
  ];
  const result = rawDifferentialsByPosition(players, positions, fixtures, [1]);
  const mid = result.find(g => g.position.id === 3)!;
  const order = mid.players.map(p => p.player.id);
  assert.deepEqual(order, [2, 3, 1, 4, 5], `expected the verified real-projection-driven order, got: ${order}`);
  assert.ok(order.indexOf(2) < order.indexOf(1), "the real high-upside pick (id 2) must rank above the barely-owned negligible one (id 1)");
});

test("rawDifferentialsByPosition: caps at 5 per position", () => {
  const players = Array.from({ length: 7 }, (_, i) => makePlayer({ id: i + 1, positionId: 3, selectedBy: 1 + i, epNext: 5 }));
  const result = rawDifferentialsByPosition(players, positions, fixtures, [1]);
  const mid = result.find(g => g.position.id === 3)!;
  assert.equal(mid.players.length, 5);
});

test("rawDifferentialsByPosition: ties on the combined rank break by id ascending", () => {
  const players = [
    makePlayer({ id: 5, positionId: 4, positionShort: "FWD", selectedBy: 10, epNext: 5 }),
    makePlayer({ id: 2, positionId: 4, positionShort: "FWD", selectedBy: 10, epNext: 5 }),
  ];
  const result = rawDifferentialsByPosition(players, positions, fixtures, [1]);
  const fwd = result.find(g => g.position.id === 4)!;
  assert.deepEqual(fwd.players.map(p => p.player.id), [2, 5]);
});

test("rawDifferentialsByPosition: selectedBy of 0 (defensive edge case) never crashes -- no division involved in the shipped rank-based design", () => {
  const player = makePlayer({ id: 1, positionId: 3, selectedBy: 0, epNext: 5 });
  const result = rawDifferentialsByPosition([player], positions, fixtures, [1]);
  const mid = result.find(g => g.position.id === 3)!;
  assert.equal(mid.players.length, 1);
  assert.ok(Number.isFinite(mid.players[0].xPts5));
});

test("rawDifferentialsByPosition: no eventIds (e.g. season already over) -- xPts5 is 0, not a crash", () => {
  const player = makePlayer({ id: 1, positionId: 3, selectedBy: 5, epNext: 5 });
  const result = rawDifferentialsByPosition([player], positions, fixtures, []);
  const mid = result.find(g => g.position.id === 3)!;
  assert.equal(mid.players[0].xPts5, 0);
});
