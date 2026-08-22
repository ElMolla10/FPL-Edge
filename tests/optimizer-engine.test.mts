import assert from "node:assert/strict";
import test from "node:test";
import { FplData, FplPlayer } from "../app/lib/fpl.ts";
import { createOptimizer } from "../app/lib/optimizer.ts";

function makePlayer(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1, name: "Test", firstName: "Test", secondName: "Player", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: 3, position: "Midfielder", positionShort: "MID", price: 6, status: "a", chance: null,
    epNext: 2, form: 2, pointsPerGame: 3, priorPointsPerGame: 3, priorMinutes: 1500, priorStarts: 20,
    priorExpectedGoals: 3, priorExpectedAssists: 3, priorBonus: 10, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 100, totalPoints: 0, eventPoints: 0, eventMinutes: 0, selectedBy: 10, priceChange: 0, priceProjectionToday: 0,
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

function makeRiskySquad(): FplPlayer[] {
  // Several low-start-probability outfield players (priorStarts=2 of 38 -> low priorStartRate,
  // clamped to the .15 floor) so deadSlots/deadForwards trip in evaluate().
  const risky = (id: number, pos: string, posId: number) =>
    makePlayer({ id, positionShort: pos, positionId: posId, priorStarts: 2, priorMinutes: 180, teamId: id, selectedBy: 1 });
  const gkps = [1, 2].map((n) => makePlayer({ id: n, positionShort: "GKP", positionId: 1, teamId: 100 + n }));
  const defs = [11, 12, 13, 14, 15].map((n) => risky(n, "DEF", 2));
  const mids = [21, 22, 23, 24, 25].map((n) => risky(n, "MID", 3));
  const fwds = [31, 32, 33].map((n) => risky(n, "FWD", 4));
  return [...gkps, ...defs, ...mids, ...fwds];
}

function makeData(squad: FplPlayer[]): FplData {
  const fixtures = [1, 2, 3, 4, 5].map((event) => ({
    id: event, event, teamH: squad[0].teamId, teamA: 900, teamHDifficulty: 3, teamADifficulty: 3,
    finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null,
  }));
  const events = [1, 2, 3, 4, 5].map((id) => ({
    id, name: `Gameweek ${id}`, deadline: new Date(Date.now() + id * 86400000).toISOString(),
    current: false, next: id === 1, finished: false, dataChecked: false,
  }));
  return {
    updatedAt: new Date().toISOString(), source: "test", seasonStatsThrough: 0,
    players: squad, fixtures, events,
    teams: [...new Set(squad.map((p) => p.teamId))].map((id) => ({ id, name: `Team ${id}`, short: `T${id}` })),
    rules: makeRules(),
  };
}

test("regression: risk-mode tolerance applies to the whole risk penalty, not just the continuous term", () => {
  const squad = makeRiskySquad();
  const data = makeData(squad);
  const penalties: Record<string, number> = {};
  for (const risk of ["Safe", "Balanced", "Aggressive"] as const) {
    const optimizer = createOptimizer(data, "Balanced 5 GWs", risk, "Maximum xPts");
    penalties[risk] = optimizer.evaluate(squad).riskPenalty;
  }
  assert.ok(penalties.Safe > penalties.Balanced, "Safe must penalize a risky squad more than Balanced");
  assert.ok(penalties.Balanced > penalties.Aggressive, "Balanced must penalize a risky squad more than Aggressive");
  // Before the fix, Safe/Aggressive differed by only the small rotationRisk*riskWeight delta
  // (~17% of the total) because the deadSlots/deadForwards threshold terms were unscaled. After
  // the fix, risk tolerance must meaningfully change the total penalty for a squad that trips
  // those thresholds.
  const range = penalties.Safe - penalties.Aggressive;
  assert.ok(range > penalties.Aggressive, `Safe-Aggressive risk penalty range (${range.toFixed(2)}) should exceed the Aggressive-mode penalty itself (${penalties.Aggressive.toFixed(2)}) for a squad that trips the dead-slot thresholds -- otherwise risk mode barely matters`);
});

test("determinism: identical squad and data produce identical evaluate() output", () => {
  const squad = makeRiskySquad();
  const data = makeData(squad);
  const optimizer = createOptimizer(data, "Balanced 5 GWs", "Balanced", "Maximum xPts");
  const first = optimizer.evaluate(squad);
  const second = optimizer.evaluate(squad);
  assert.deepEqual(first, second, "calling evaluate() twice with identical inputs must yield identical output");
});
