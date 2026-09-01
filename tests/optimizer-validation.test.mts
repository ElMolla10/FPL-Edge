import assert from "node:assert/strict";
import test from "node:test";
import { FplData, FplPlayer } from "../app/lib/fpl.ts";
import { SquadEvaluation, WeekPlan, createOptimizer, validateSquadEvaluation } from "../app/lib/optimizer.ts";

function makePlayer(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1, name: "Test", firstName: "Test", secondName: "Player", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: 3, position: "Midfielder", positionShort: "MID", price: 6, status: "a", chance: null,
    epNext: 4, form: 4, pointsPerGame: 4, priorPointsPerGame: 4, priorMinutes: 2500, priorStarts: 30,
    priorExpectedGoals: 5, priorExpectedAssists: 5, priorBonus: 12, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 60, totalPoints: 0, eventPoints: 0, eventMinutes: 0, eventBonus: 0, eventDefensiveContribution: 0, selectedBy: 10, priceChange: 0, priceProjectionToday: 0,
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

// A clean, legal 15-player squad -- distinct clubs (no accidental >3-per-club trip), decent prior
// output so weekPlan produces a normal, non-degenerate XI/bench/captain/vice.
function makeCleanSquad(): FplPlayer[] {
  const gkps = [1, 2].map((id) => makePlayer({ id, name: `GKP${id}`, teamId: id, positionShort: "GKP", positionId: 1, price: 5 }));
  const defs = [11, 12, 13, 14, 15].map((id) => makePlayer({ id, name: `DEF${id}`, teamId: id, positionShort: "DEF", positionId: 2, price: 5.5 }));
  const mids = [21, 22, 23, 24, 25].map((id) => makePlayer({ id, name: `MID${id}`, teamId: id, positionShort: "MID", positionId: 3, price: 7 }));
  const fwds = [31, 32, 33].map((id) => makePlayer({ id, name: `FWD${id}`, teamId: id, positionShort: "FWD", positionId: 4, price: 7.5 }));
  return [...gkps, ...defs, ...mids, ...fwds];
}

function makeData(squad: FplPlayer[]): FplData {
  const teamIds = [...new Set(squad.map((p) => p.teamId))];
  const fixtures = [1, 2, 3, 4, 5].flatMap((event) =>
    teamIds.map((teamId, index) => ({
      id: event * 100 + index, event, teamH: teamId, teamA: 900 + index, teamHDifficulty: 3, teamADifficulty: 3,
      finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null,
    }))
  );
  const events = [1, 2, 3, 4, 5].map((id) => ({
    id, name: `Gameweek ${id}`, deadline: new Date(1893456000000 + id * 86400000).toISOString(),
    current: false, next: id === 1, finished: false, dataChecked: false,
  }));
  return {
    updatedAt: new Date(1893456000000).toISOString(), source: "test", seasonStatsThrough: 0,
    players: squad, fixtures, events,
    teams: teamIds.map((id) => ({ id, name: `Team ${id}`, short: `T${id}` })),
    rules: makeRules(),
  };
}

const squad = makeCleanSquad();
const data = makeData(squad);
const optimizer = createOptimizer(data, "Balanced 5 GWs", "Balanced", "Maximum xPts");
const evaluation = optimizer.evaluate(squad);

test("validateSquadEvaluation: a genuinely valid evaluation produces no warnings", () => {
  assert.deepEqual(validateSquadEvaluation(evaluation, squad, data), []);
});

test("validateSquadEvaluation: catches an XI that isn't exactly 11 players", () => {
  const broken: SquadEvaluation = { ...evaluation, weeks: [{ ...evaluation.weeks[0], xi: evaluation.weeks[0].xi.slice(0, 10) }, ...evaluation.weeks.slice(1)] };
  const warnings = validateSquadEvaluation(broken, squad, data);
  assert.ok(warnings.some((w) => w.includes("not 11")), `expected an XI-size warning, got: ${JSON.stringify(warnings)}`);
});

test("validateSquadEvaluation: catches an XI formation outside data.rules.positions' legal min/max range", () => {
  // 1 GKP + 2 DEF (below the legal 3-5 range) + 5 MID + 3 FWD = 11 players, so this isolates the
  // formation-legality check from the XI-size check above. Indices: squad = [2 GKP, 5 DEF, 5 MID, 3 FWD].
  const illegalXi = [squad[0], squad[2], squad[3], ...squad.slice(7, 12), ...squad.slice(12, 15)];
  assert.equal(illegalXi.length, 11);
  assert.equal(illegalXi.filter((p) => p.positionShort === "DEF").length, 2, "sanity check: exactly 2 DEF, below the legal minimum of 3");
  const week: WeekPlan = { ...evaluation.weeks[0], xi: illegalXi };
  const broken: SquadEvaluation = { ...evaluation, weeks: [week, ...evaluation.weeks.slice(1)] };
  const warnings = validateSquadEvaluation(broken, squad, data);
  assert.ok(warnings.some((w) => w.includes("outside the legal")), `expected a formation-legality warning, got: ${JSON.stringify(warnings)}`);
});

test("validateSquadEvaluation: catches a captain who isn't in the XI", () => {
  const benchPlayer = squad.find((p) => !evaluation.weeks[0].xi.some((x) => x.id === p.id))!;
  const week: WeekPlan = { ...evaluation.weeks[0], captain: benchPlayer };
  const broken: SquadEvaluation = { ...evaluation, weeks: [week, ...evaluation.weeks.slice(1)] };
  const warnings = validateSquadEvaluation(broken, squad, data);
  assert.ok(warnings.some((w) => w.includes("captain") && w.includes("not in the XI")), `expected a captain-not-in-XI warning, got: ${JSON.stringify(warnings)}`);
});

test("validateSquadEvaluation: catches a vice-captain who isn't in the XI", () => {
  const benchPlayer = squad.find((p) => !evaluation.weeks[0].xi.some((x) => x.id === p.id))!;
  const week: WeekPlan = { ...evaluation.weeks[0], vice: benchPlayer };
  const broken: SquadEvaluation = { ...evaluation, weeks: [week, ...evaluation.weeks.slice(1)] };
  const warnings = validateSquadEvaluation(broken, squad, data);
  assert.ok(warnings.some((w) => w.includes("vice-captain") && w.includes("not in the XI")), `expected a vice-not-in-XI warning, got: ${JSON.stringify(warnings)}`);
});

test("validateSquadEvaluation: catches a displayed points total that doesn't reconcile with the XI + captain bonus", () => {
  const week: WeekPlan = { ...evaluation.weeks[0], points: evaluation.weeks[0].points + 50 };
  const broken: SquadEvaluation = { ...evaluation, weeks: [week, ...evaluation.weeks.slice(1)] };
  const warnings = validateSquadEvaluation(broken, squad, data);
  assert.ok(warnings.some((w) => w.includes("does not reconcile") && w.includes("captain bonus")), `expected a points-reconciliation warning, got: ${JSON.stringify(warnings)}`);
});

test("validateSquadEvaluation: catches a backup goalkeeper who isn't in the final bench slot", () => {
  const bench = [...evaluation.weeks[0].bench];
  const gkIndex = bench.findIndex((p) => p.positionShort === "GKP");
  assert.equal(gkIndex, bench.length - 1, "sanity check: the real optimizer output puts GKP last, as expected");
  [bench[0], bench[gkIndex]] = [bench[gkIndex], bench[0]];
  const week: WeekPlan = { ...evaluation.weeks[0], bench };
  const broken: SquadEvaluation = { ...evaluation, weeks: [week, ...evaluation.weeks.slice(1)] };
  const warnings = validateSquadEvaluation(broken, squad, data);
  assert.ok(warnings.some((w) => w.includes("backup goalkeeper is not in the final bench slot")), `expected a bench-order warning, got: ${JSON.stringify(warnings)}`);
});

test("validateSquadEvaluation: catches a squad cost that doesn't reconcile with the displayed per-position budget", () => {
  const broken: SquadEvaluation = { ...evaluation, strategy: { ...evaluation.strategy, budget: { ...evaluation.strategy.budget, MID: evaluation.strategy.budget.MID + 10 } } };
  const warnings = validateSquadEvaluation(broken, squad, data);
  assert.ok(warnings.some((w) => w.includes("Squad cost") && w.includes("does not reconcile")), `expected a cost-reconciliation warning, got: ${JSON.stringify(warnings)}`);
});

test("validateSquadEvaluation: catches more than the club limit from a single team", () => {
  // squad[0] (id 1) already occupies team 1 alone; moving 3 more players onto it makes 4 total,
  // one more than the 3-player limit.
  const brokenSquad = squad.map((p) => ([12, 13, 21].includes(p.id) ? { ...p, teamId: squad[0].teamId } : p));
  assert.equal(brokenSquad.filter((p) => p.teamId === squad[0].teamId).length, 4, "sanity check: 4 players now share the same club");
  const warnings = validateSquadEvaluation(evaluation, brokenSquad, data);
  assert.ok(warnings.some((w) => w.includes("exceeding the 3-player limit")), `expected a club-limit warning, got: ${JSON.stringify(warnings)}`);
});
