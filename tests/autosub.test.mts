import assert from "node:assert/strict";
import test from "node:test";
import { FplPlayer, simulateAutosubs } from "../app/lib/fpl.ts";

function makePlayer(overrides: Partial<FplPlayer> & { id: number; name: string; positionShort: string; eventMinutes: number }): FplPlayer {
  return {
    firstName: overrides.name, secondName: "", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: overrides.positionShort === "GKP" ? 1 : overrides.positionShort === "DEF" ? 2 : overrides.positionShort === "MID" ? 3 : 4,
    position: overrides.positionShort, price: 5, status: "a", chance: null,
    epNext: 3, form: 3, pointsPerGame: 3, priorPointsPerGame: 3, priorMinutes: 1000, priorStarts: 12,
    priorExpectedGoals: 2, priorExpectedAssists: 1, priorBonus: 5, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 0, totalPoints: 30, eventPoints: 0, selectedBy: 10, priceChange: 0, priceProjectionToday: 0,
    transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0,
    expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 500,
    starts: 5, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0,
    penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
    ...overrides,
  };
}

// Standard 4-3-3 XI used by most tests below.
function standardXi() {
  return [
    makePlayer({ id: 1, name: "GK", positionShort: "GKP", eventMinutes: 90 }),
    makePlayer({ id: 2, name: "DEF1", positionShort: "DEF", eventMinutes: 90 }),
    makePlayer({ id: 3, name: "DEF2", positionShort: "DEF", eventMinutes: 90 }),
    makePlayer({ id: 4, name: "DEF3", positionShort: "DEF", eventMinutes: 90 }),
    makePlayer({ id: 5, name: "DEF4", positionShort: "DEF", eventMinutes: 90 }),
    makePlayer({ id: 6, name: "MID1", positionShort: "MID", eventMinutes: 90 }),
    makePlayer({ id: 7, name: "MID2", positionShort: "MID", eventMinutes: 90 }),
    makePlayer({ id: 8, name: "MID3", positionShort: "MID", eventMinutes: 90 }),
    makePlayer({ id: 9, name: "FWD1", positionShort: "FWD", eventMinutes: 90 }),
    makePlayer({ id: 10, name: "FWD2", positionShort: "FWD", eventMinutes: 90 }),
    makePlayer({ id: 11, name: "FWD3", positionShort: "FWD", eventMinutes: 90 }),
  ];
}

function standardBench() {
  return [
    makePlayer({ id: 12, name: "BenchGK", positionShort: "GKP", eventMinutes: 90 }),
    makePlayer({ id: 13, name: "Bench1", positionShort: "MID", eventMinutes: 90 }),
    makePlayer({ id: 14, name: "Bench2", positionShort: "DEF", eventMinutes: 90 }),
    makePlayer({ id: 15, name: "Bench3", positionShort: "FWD", eventMinutes: 90 }),
  ];
}

test("simulateAutosubs: no 0-minute starters -- XI unchanged, no swaps, captain unchanged", () => {
  const xi = standardXi();
  const result = simulateAutosubs(xi, standardBench(), 9, 6);

  assert.deepEqual(result.effectiveXi.map((p) => p.id), xi.map((p) => p.id));
  assert.deepEqual(result.swaps, []);
  assert.deepEqual(result.unfilled, []);
  assert.equal(result.effectiveCaptainId, 9);
  assert.equal(result.armbandPassedToVice, false);
  assert.equal(result.doubleLost, false);
});

test("simulateAutosubs: starting GK plays 0 minutes and bench GK played -- GK is swapped in", () => {
  const xi = standardXi();
  xi[0] = makePlayer({ id: 1, name: "GK", positionShort: "GKP", eventMinutes: 0 });
  const result = simulateAutosubs(xi, standardBench(), 9, 6);

  assert.equal(result.swaps.length, 1);
  assert.deepEqual(result.swaps[0], { outId: 1, outName: "GK", inId: 12, inName: "BenchGK" });
  assert.ok(result.effectiveXi.some((p) => p.id === 12));
  assert.ok(!result.effectiveXi.some((p) => p.id === 1));
  assert.deepEqual(result.unfilled, []);
});

test("simulateAutosubs: starting GK and bench GK both play 0 minutes -- GK slot stays unfilled, no swap", () => {
  const xi = standardXi();
  xi[0] = makePlayer({ id: 1, name: "GK", positionShort: "GKP", eventMinutes: 0 });
  const bench = standardBench();
  bench[0] = makePlayer({ id: 12, name: "BenchGK", positionShort: "GKP", eventMinutes: 0 });
  const result = simulateAutosubs(xi, bench, 9, 6);

  assert.deepEqual(result.swaps, []);
  assert.equal(result.unfilled.length, 1);
  assert.equal(result.unfilled[0].id, 1);
});

test("simulateAutosubs: an outfield starter plays 0 minutes -- the first bench player in order that keeps the formation legal is swapped in, regardless of position", () => {
  // Real FPL autosub doesn't require the incoming sub to share the outgoing starter's position --
  // only that the resulting formation stays legal. Bench order 1 (a MID) can and does replace a
  // 0-minute FWD here: DEF stays 4, MID goes 3->4, FWD goes 3->2 -- all within the legal 3-5/2-5/1-3
  // bounds, so bench priority order wins over "natural" position matching.
  const xi = standardXi();
  xi[8] = makePlayer({ id: 9, name: "FWD1", positionShort: "FWD", eventMinutes: 0 });
  const result = simulateAutosubs(xi, standardBench(), 9, 6);

  assert.equal(result.swaps.length, 1);
  assert.deepEqual(result.swaps[0], { outId: 9, outName: "FWD1", inId: 13, inName: "Bench1" });
  assert.ok(result.effectiveXi.some((p) => p.id === 13));
  assert.deepEqual(result.unfilled, []);
});

test("simulateAutosubs: bench priority skips a formation-illegal swap and uses the next eligible bench player instead", () => {
  // 3-5-2: DEF at the legal minimum (3). The first outfield bench player is a MID -- swapping
  // them in for the 0-minute DEF would drop DEF to 2 (illegal) and push MID to 6 (also illegal).
  // The second outfield bench player is a DEF -- that swap keeps DEF at 3 and is legal.
  const xi = [
    makePlayer({ id: 1, name: "GK", positionShort: "GKP", eventMinutes: 90 }),
    makePlayer({ id: 2, name: "DEF1", positionShort: "DEF", eventMinutes: 90 }),
    makePlayer({ id: 3, name: "DEF2", positionShort: "DEF", eventMinutes: 90 }),
    makePlayer({ id: 4, name: "DEF3", positionShort: "DEF", eventMinutes: 0 }),
    makePlayer({ id: 5, name: "MID1", positionShort: "MID", eventMinutes: 90 }),
    makePlayer({ id: 6, name: "MID2", positionShort: "MID", eventMinutes: 90 }),
    makePlayer({ id: 7, name: "MID3", positionShort: "MID", eventMinutes: 90 }),
    makePlayer({ id: 8, name: "MID4", positionShort: "MID", eventMinutes: 90 }),
    makePlayer({ id: 9, name: "MID5", positionShort: "MID", eventMinutes: 90 }),
    makePlayer({ id: 10, name: "FWD1", positionShort: "FWD", eventMinutes: 90 }),
    makePlayer({ id: 11, name: "FWD2", positionShort: "FWD", eventMinutes: 90 }),
  ];
  const bench = [
    makePlayer({ id: 12, name: "BenchGK", positionShort: "GKP", eventMinutes: 90 }),
    makePlayer({ id: 13, name: "BenchMid", positionShort: "MID", eventMinutes: 90 }),
    makePlayer({ id: 14, name: "BenchDef", positionShort: "DEF", eventMinutes: 90 }),
    makePlayer({ id: 15, name: "BenchFwd", positionShort: "FWD", eventMinutes: 90 }),
  ];
  const result = simulateAutosubs(xi, bench, 10, 5);

  assert.equal(result.swaps.length, 1, "exactly one swap should happen -- BenchMid must not come on");
  assert.deepEqual(result.swaps[0], { outId: 4, outName: "DEF3", inId: 14, inName: "BenchDef" });
  assert.ok(!result.effectiveXi.some((p) => p.id === 13), "BenchMid stays on the bench -- would have broken formation");
  assert.equal(result.effectiveXi.filter((p) => p.positionShort === "DEF").length, 3);
});

test("simulateAutosubs: two 0-minute starters are both filled by separate bench players, in bench order, one call", () => {
  const xi = standardXi();
  xi[8] = makePlayer({ id: 9, name: "FWD1", positionShort: "FWD", eventMinutes: 0 });
  xi[5] = makePlayer({ id: 6, name: "MID1", positionShort: "MID", eventMinutes: 0 });
  const result = simulateAutosubs(xi, standardBench(), 9, 6);

  // Bench1 (MID) fills MID1 first (same-position match found first since MID1 is earlier in the
  // XI). Bench2 (DEF) then fills FWD1 (DEF 4->5 stays legal). Bench3 (FWD) is never needed.
  assert.equal(result.swaps.length, 2);
  assert.deepEqual(result.unfilled, []);
  assert.ok(result.effectiveXi.some((p) => p.id === 13));
  assert.ok(result.effectiveXi.some((p) => p.id === 14));
  assert.ok(!result.effectiveXi.some((p) => p.id === 15), "Bench3 should not be needed once the other two fill both gaps");
});

test("simulateAutosubs: bench players who themselves recorded 0 minutes cannot come on -- starter stays unfilled", () => {
  const xi = standardXi();
  xi[8] = makePlayer({ id: 9, name: "FWD1", positionShort: "FWD", eventMinutes: 0 });
  const bench = [
    makePlayer({ id: 12, name: "BenchGK", positionShort: "GKP", eventMinutes: 90 }),
    makePlayer({ id: 13, name: "Bench1", positionShort: "MID", eventMinutes: 0 }),
    makePlayer({ id: 14, name: "Bench2", positionShort: "DEF", eventMinutes: 0 }),
    makePlayer({ id: 15, name: "Bench3", positionShort: "FWD", eventMinutes: 0 }),
  ];
  const result = simulateAutosubs(xi, bench, 9, 6);

  assert.deepEqual(result.swaps, []);
  assert.equal(result.unfilled.length, 1);
  assert.equal(result.unfilled[0].id, 9);
});

test("simulateAutosubs: captain plays 0 minutes and vice played -- armband passes to vice", () => {
  const xi = standardXi();
  xi[8] = makePlayer({ id: 9, name: "FWD1", positionShort: "FWD", eventMinutes: 0 });
  const result = simulateAutosubs(xi, standardBench(), 9, 6);

  assert.equal(result.effectiveCaptainId, 6);
  assert.equal(result.armbandPassedToVice, true);
  assert.equal(result.doubleLost, false);
});

test("simulateAutosubs: both captain and vice play 0 minutes -- no one gets the double", () => {
  const xi = standardXi();
  xi[8] = makePlayer({ id: 9, name: "FWD1", positionShort: "FWD", eventMinutes: 0 });
  xi[5] = makePlayer({ id: 6, name: "MID1", positionShort: "MID", eventMinutes: 0 });
  const result = simulateAutosubs(xi, standardBench(), 9, 6);

  assert.equal(result.effectiveCaptainId, null);
  assert.equal(result.armbandPassedToVice, false);
  assert.equal(result.doubleLost, true);
});

test("simulateAutosubs: captain plays normally -- armband stays, unaffected by unrelated autosubs elsewhere", () => {
  const xi = standardXi();
  xi[10] = makePlayer({ id: 11, name: "FWD3", positionShort: "FWD", eventMinutes: 0 });
  const result = simulateAutosubs(xi, standardBench(), 9, 6);

  assert.equal(result.effectiveCaptainId, 9);
  assert.equal(result.armbandPassedToVice, false);
  assert.equal(result.doubleLost, false);
});
