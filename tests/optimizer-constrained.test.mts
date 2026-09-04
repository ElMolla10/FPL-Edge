import assert from "node:assert/strict";
import test from "node:test";
import { FplData, FplPlayer, isValidSquad } from "../app/lib/fpl.ts";
import { createOptimizer } from "../app/lib/optimizer.ts";

function makePlayer(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1, name: "Test", firstName: "Test", secondName: "Player", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: 3, position: "Midfielder", positionShort: "MID", price: 6, status: "a", chance: null,
    epNext: 2, form: 2, pointsPerGame: 3, priorPointsPerGame: 3, priorMinutes: 2500, priorStarts: 30,
    priorExpectedGoals: 3, priorExpectedAssists: 3, priorBonus: 10, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 100, totalPoints: 0, eventPoints: 0, eventMinutes: 0, eventBonus: 0, eventDefensiveContribution: 0, selectedBy: 10, priceChange: 0, priceProjectionToday: 0, priceChangeSinceStart: 0, priceOutlook: [],
    transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0,
    expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 0,
    starts: 0, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0,
    penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
    ...overrides,
  };
}

function makeRules() {
  return {
    budget: 100, squadSize: 15, teamLimit: 3,
    positions: [
      { id: 1, name: "Goalkeeper", short: "GKP", squad: 2, minPlay: 1, maxPlay: 1 },
      { id: 2, name: "Defender", short: "DEF", squad: 5, minPlay: 3, maxPlay: 5 },
      { id: 3, name: "Midfielder", short: "MID", squad: 5, minPlay: 2, maxPlay: 5 },
      { id: 4, name: "Forward", short: "FWD", squad: 3, minPlay: 1, maxPlay: 3 },
    ],
  };
}

// A baseline valid 15-player squad, deliberately bland (uniform price/quality) so each test can
// overlay its own specific weak spot(s) without fighting unrelated variation elsewhere in the squad.
function baseSquad(): FplPlayer[] {
  const gkps = [1, 2].map((n) => makePlayer({ id: n, positionShort: "GKP", positionId: 1, position: "Goalkeeper", price: 4.5, epNext: 3, teamId: 100 + n }));
  const defs = [11, 12, 13, 14, 15].map((n) => makePlayer({ id: n, positionShort: "DEF", positionId: 2, position: "Defender", price: 5, epNext: 3, teamId: 200 + n }));
  const mids = [21, 22, 23, 24, 25].map((n) => makePlayer({ id: n, positionShort: "MID", positionId: 3, position: "Midfielder", price: 6, epNext: 3, teamId: 300 + n }));
  const fwds = [31, 32, 33].map((n) => makePlayer({ id: n, positionShort: "FWD", positionId: 4, position: "Forward", price: 6, epNext: 3, teamId: 400 + n }));
  return [...gkps, ...defs, ...mids, ...fwds];
}

// projectionMetricsBase forces xPts to 0 for any player with no scheduled fixture that gameweek
// (games.length ? ... : 0 in app/lib/fpl.ts) -- every distinct team therefore needs a real fixture
// each event, or its players silently project 0 regardless of any quality field, making price/prior
// stats irrelevant to the objective. Every real team plays a shared filler opponent (id -1, used by
// no real player) each event so every player in every test squad/pool actually gets scored.
function makeData(players: FplPlayer[]): FplData {
  const teamIds = [...new Set(players.map((p) => p.teamId))];
  const fixtures = [1, 2, 3, 4, 5].flatMap((event) =>
    teamIds.map((teamId) => ({
      id: event * 10000 + teamId, event, teamH: teamId, teamA: -1, teamHDifficulty: 3, teamADifficulty: 3,
      finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null,
    }))
  );
  const events = [1, 2, 3, 4, 5].map((id) => ({
    id, name: `Gameweek ${id}`, deadline: new Date(Date.now() + id * 86400000).toISOString(),
    current: false, next: id === 1, finished: false, dataChecked: false,
  }));
  return {
    updatedAt: new Date().toISOString(), source: "test", seasonStatsThrough: 0,
    players, fixtures, events,
    teams: [...new Set(players.map((p) => p.teamId))].map((id) => ({ id, name: `Team ${id}`, short: `T${id}` })),
    rules: makeRules(),
  };
}

// --- Test 1: Practical Upgrade never exceeds maxChanges swaps, even when a bigger rebuild scores higher ---
test("optimizeConstrained caps swaps at maxChanges even when a 4-swap rebuild would score strictly higher", () => {
  const squad = baseSquad();
  // Replace the 5 MID slots with 4 weak (low prior output) + 1 untouched average MID, so exactly 4
  // independent, equal-value upgrade opportunities exist in one position. Price matches the squad's
  // own default MID price throughout (weak MIDs, avg MID, and upgrades) so the swap's budget/bank
  // cost is identical regardless of which slot is touched -- isolating priorExpectedGoals/Assists
  // (the real xPts driver, see app/lib/fpl.ts's projectionMetricsBase) as the only variable that can
  // differentiate one candidate from another. Equal-price candidates that still differ sharply in
  // quality/price ratio was the exact confound that caused this test to fail its first draft: default
  // makePlayer() quality fields (priorExpectedGoals/Assists) were left untouched on the "weak" players
  // while only epNext/priorPointsPerGame varied, and epNext contributes only 18% weight on the first
  // event -- nowhere near enough to make a "weak" player meaningfully worse than a default one.
  const weakMids = [21, 22, 23, 24].map((n) => makePlayer({ id: n, positionShort: "MID", positionId: 3, position: "Midfielder", price: 6, priorExpectedGoals: 0.2, priorExpectedAssists: 0.1, priorMinutes: 2500, priorStarts: 30, teamId: 300 + n }));
  const avgMid = makePlayer({ id: 25, positionShort: "MID", positionId: 3, position: "Midfielder", price: 6, priorMinutes: 2500, priorStarts: 30, teamId: 325 });
  const squadWithWeakMids = squad.filter((p) => p.positionShort !== "MID").concat(weakMids, avgMid);
  // 4 upgrade candidates, comfortably affordable individually and all together (plenty of bank).
  const upgrades = [910, 911, 912, 913].map((n) => makePlayer({ id: n, positionShort: "MID", positionId: 3, position: "Midfielder", price: 6, priorExpectedGoals: 15, priorExpectedAssists: 10, priorMinutes: 2500, priorStarts: 30, teamId: 900 + n }));
  const data = makeData([...squadWithWeakMids, ...upgrades]);
  const optimizer = createOptimizer(data, "Balanced 5 GWs", "Balanced", "Maximum xPts");

  const capped = optimizer.optimizeConstrained(squadWithWeakMids, { maxChanges: 3 });
  const uncapped = optimizer.optimizeConstrained(squadWithWeakMids, { maxChanges: 4 });

  assert.ok(capped.changes.length <= 3, `maxChanges:3 must never return more than 3 changes, got ${capped.changes.length}`);
  assert.ok(isValidSquad(capped.squad, data));
  assert.ok(isValidSquad(uncapped.squad, data));
  assert.equal(uncapped.changes.length, 4, "the true best move here requires all 4 independent upgrades");
  assert.ok(
    uncapped.evaluation.objective > capped.evaluation.objective,
    `uncapped (${uncapped.evaluation.objective.toFixed(3)}) must score strictly higher than the maxChanges:3-capped result (${capped.evaluation.objective.toFixed(3)}) -- otherwise the cap was never actually binding`
  );
});

// --- Test 2: Keep Core never swaps out a pinned player, even when it would score higher ---
test("optimizeConstrained never returns a change with a locked player as the 'out', even when unlocked it is the top pick", () => {
  const squad = baseSquad();
  // Same price-equalized construction as Test 1. The other 4 MIDs are ALSO bumped to elite-tier
  // output (matching the incoming candidate) so eliteMid is not an improvement over them -- isolating
  // the single improving opportunity to weakMid alone. Without this, the other 4 default-quality MIDs
  // (priorExpectedGoals/Assists=3/3) are also worse than eliteMid, so locking weakMid just makes the
  // search settle for the next-best swap elsewhere, which is a real, separate finding worth its own
  // comment but not what this specific test is isolating.
  const strongMids = [22, 23, 24, 25].map((n) => makePlayer({ id: n, positionShort: "MID", positionId: 3, position: "Midfielder", price: 6, priorExpectedGoals: 15, priorExpectedAssists: 10, priorMinutes: 2500, priorStarts: 30, teamId: 300 + n }));
  const weakMid = makePlayer({ id: 21, positionShort: "MID", positionId: 3, position: "Midfielder", price: 6, priorExpectedGoals: 0.2, priorExpectedAssists: 0.1, priorMinutes: 2500, priorStarts: 30, teamId: 321 });
  const squadWithWeak = squad.filter((p) => p.positionShort !== "MID").concat(weakMid, strongMids);
  // Price matches strongMids exactly (not just weakMid) -- with quality also matching strongMids,
  // eliteMid is a genuine no-op swap against them (same projected output, same price/price-bracket
  // scoring), so it can only be an improvement over weakMid specifically. An earlier draft priced
  // eliteMid at 8 and found it swapped in for a strongMid anyway despite identical projected points --
  // real behavior, not a bug: app/lib/optimizer.ts's pricePointScore rewards a MID priced in the
  // £7-8m bracket independently of projected points, so a same-quality-but-differently-priced
  // "upgrade" can still nudge the objective. Equalizing price here isolates the property this test
  // is actually about.
  const eliteMid = makePlayer({ id: 920, positionShort: "MID", positionId: 3, position: "Midfielder", price: 6, priorExpectedGoals: 15, priorExpectedAssists: 10, priorMinutes: 2500, priorStarts: 30, teamId: 920 });
  const data = makeData([...squadWithWeak, eliteMid]);
  const optimizer = createOptimizer(data, "Balanced 5 GWs", "Balanced", "Maximum xPts");

  // Adversarial premise check: unlocked, the search DOES pick this exact swap -- proving the lock
  // below actually changes the outcome rather than testing a swap that was never going to happen.
  const unlocked = optimizer.optimizeConstrained(squadWithWeak, { maxChanges: 1 });
  assert.equal(unlocked.changes.length, 1);
  assert.equal(unlocked.changes[0].out.id, weakMid.id);
  assert.equal(unlocked.changes[0].incoming.id, eliteMid.id);

  const locked = optimizer.optimizeConstrained(squadWithWeak, { maxChanges: 1, lockedPlayerIds: new Set([weakMid.id]) });
  assert.equal(locked.changes.length, 0, "with the only beneficial swap's 'out' locked, no legal beneficial combo remains");
  assert.ok(!locked.changes.some((c) => c.out.id === weakMid.id));
  assert.equal(locked.squad.find((p) => p.id === weakMid.id)?.id, weakMid.id, "the locked player must still be in the returned squad");
});

// --- Test 3: both modes always return a squad that passes isValidSquad, including tight edge cases ---
test("optimizeConstrained always returns a legal squad, across varied configurations and at tight budget/club edges", () => {
  const squad = baseSquad();
  const wideDefPool = Array.from({ length: 12 }, (_, i) => makePlayer({ id: 950 + i, positionShort: "DEF", positionId: 2, position: "Defender", price: 4 + (i % 6), epNext: 1 + (i % 5), teamId: 950 + (i % 4) }));
  const wideMidPool = Array.from({ length: 12 }, (_, i) => makePlayer({ id: 970 + i, positionShort: "MID", positionId: 3, position: "Midfielder", price: 4.5 + (i % 7), epNext: 1 + (i % 6), teamId: 970 + (i % 4) }));
  const data = makeData([...squad, ...wideDefPool, ...wideMidPool]);
  const optimizer = createOptimizer(data, "Balanced 5 GWs", "Balanced", "Maximum xPts");

  const configs: { maxChanges: number; lockedPlayerIds?: Set<number> }[] = [
    { maxChanges: 0 },
    { maxChanges: 1 },
    { maxChanges: 2 },
    { maxChanges: 3 },
    { maxChanges: 3, lockedPlayerIds: new Set([21, 22, 23]) },
    { maxChanges: 4, lockedPlayerIds: new Set(squad.slice(0, 13).map((p) => p.id)) }, // only 2 unlocked
  ];
  for (const config of configs) {
    const result = optimizer.optimizeConstrained(squad, config);
    assert.ok(isValidSquad(result.squad, data), `config ${JSON.stringify({ ...config, lockedPlayerIds: config.lockedPlayerIds ? [...config.lockedPlayerIds] : undefined })} produced an illegal squad`);
  }

  // Tight edge case: squad sits exactly at the £100.0m budget ceiling AND exactly at the 3-per-club
  // cap in two different clubs -- this is the specific interaction that broke the first draft of the
  // shortlist ranking during the design-checkpoint verification.
  const tightMids = [21, 22, 23].map((n) => makePlayer({ id: n, positionShort: "MID", positionId: 3, position: "Midfielder", price: 6, epNext: 3, teamId: 500 })); // 3 from club 500
  const tightDefs = [11, 12, 13].map((n) => makePlayer({ id: n, positionShort: "DEF", positionId: 2, position: "Defender", price: 5, epNext: 3, teamId: 600 })); // 3 from club 600
  const restOfSquad = squad.filter((p) => !["11", "12", "13", "21", "22", "23"].includes(String(p.id)));
  const tightSquadRaw = [...restOfSquad, ...tightDefs, ...tightMids];
  const currentCost = tightSquadRaw.reduce((s, p) => s + p.price, 0);
  // Nudge one untouched player's price so total cost lands exactly at the £100.0m ceiling.
  const adjusted = tightSquadRaw.map((p) => (p.id === 14 ? { ...p, price: p.price + (100 - currentCost) } : p));
  const tightData = makeData([...adjusted, ...wideDefPool, ...wideMidPool]);
  const tightOptimizer = createOptimizer(tightData, "Balanced 5 GWs", "Balanced", "Maximum xPts");
  assert.ok(isValidSquad(adjusted, tightData), "test setup sanity check: the tight squad itself must be legal before searching");
  const tightResult = tightOptimizer.optimizeConstrained(adjusted, { maxChanges: 3 });
  assert.ok(isValidSquad(tightResult.squad, tightData));
});

// --- Test 4: no real improvement within the constraint -> returns the original squad, not a forced change ---
test("optimizeConstrained returns the original squad unchanged when no legal combo improves on it", () => {
  const squad = baseSquad();
  // Pool candidates exist (so combinations really do get considered) but are all strictly worse --
  // priorExpectedGoals/Assists below the squad's own default MIDs (3/3), matching price so budget
  // effects can't accidentally make an inferior player look attractive.
  const worsePool = Array.from({ length: 8 }, (_, i) => makePlayer({ id: 980 + i, positionShort: "MID", positionId: 3, position: "Midfielder", price: 6, priorExpectedGoals: 1, priorExpectedAssists: 0.5, priorMinutes: 2500, priorStarts: 30, teamId: 980 + i }));
  const data = makeData([...squad, ...worsePool]);
  const optimizer = createOptimizer(data, "Balanced 5 GWs", "Balanced", "Maximum xPts");

  const result = optimizer.optimizeConstrained(squad, { maxChanges: 3 });
  assert.equal(result.changes.length, 0);
  assert.deepEqual(result.squad.map((p) => p.id).sort(), squad.map((p) => p.id).sort());
  assert.equal(result.evaluation.objective, optimizer.evaluate(squad).objective);
  assert.ok(result.consideredCombinations > 0, "combinations must have actually been generated and evaluated, not just trivially skipped");
});

// --- Test 5: determinism -- same input twice produces byte-identical output ---
test("optimizeConstrained is deterministic: identical input produces identical output", () => {
  const squad = baseSquad();
  const pool = Array.from({ length: 10 }, (_, i) => makePlayer({ id: 990 + i, positionShort: "DEF", positionId: 2, position: "Defender", price: 4.5 + (i % 5), epNext: 1 + (i % 6), teamId: 990 + (i % 5) }));
  const data = makeData([...squad, ...pool]);
  const optimizer = createOptimizer(data, "Balanced 5 GWs", "Balanced", "Maximum xPts");

  const first = optimizer.optimizeConstrained(squad, { maxChanges: 2 });
  const second = optimizer.optimizeConstrained(squad, { maxChanges: 2 });
  assert.deepEqual(first.changes.map((c) => [c.out.id, c.incoming.id]), second.changes.map((c) => [c.out.id, c.incoming.id]));
  assert.equal(first.evaluation.objective, second.evaluation.objective);
  assert.equal(first.consideredCombinations, second.consideredCombinations);
});
