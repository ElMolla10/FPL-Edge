import assert from "node:assert/strict";
import test from "node:test";
import { FplPlayer } from "../app/lib/fpl.ts";
import { HistoryWeek, teamValueSummary } from "../app/components/LiveIntelligence.tsx";

function makeWeek(overrides: Partial<HistoryWeek> = {}): HistoryWeek {
  return {
    event: 1, points: 60, totalPoints: 60, overallRank: 100000, gameweekRank: 50000, transfers: 0, transferCost: 0,
    pointsOnBench: 4, value: 100, bank: 0, captain: "Captain", captainRawPoints: 10, captainContribution: 20,
    viceCaptain: "Vice", chip: null,
    ...overrides,
  };
}

function makePlayer(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1, name: "Player", firstName: "Player", secondName: "One", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: 4, position: "Forward", positionShort: "FWD", price: 8, status: "a", chance: null,
    epNext: 5, form: 5, pointsPerGame: 5, priorPointsPerGame: 5, priorMinutes: 2000, priorStarts: 25,
    priorExpectedGoals: 10, priorExpectedAssists: 3, priorBonus: 15, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 0, totalPoints: 0, eventPoints: 0, eventMinutes: 0, eventBonus: 0, eventDefensiveContribution: 0, selectedBy: 20, priceChange: 0, priceProjectionToday: 0, priceChangeSinceStart: 0, priceOutlook: [],
    transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0,
    expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 0,
    starts: 0, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0,
    penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
    ...overrides,
  };
}

test("teamValueSummary: no finished gameweeks yet -- null, not a crash", () => {
  assert.equal(teamValueSummary([], null), null);
});

test("teamValueSummary: baseline is the FIRST finished gameweek, latest is the LAST -- real GW labels attached", () => {
  const weeks = [makeWeek({ event: 1, value: 100 }), makeWeek({ event: 2, value: 100.3 }), makeWeek({ event: 3, value: 101.1 })];
  const result = teamValueSummary(weeks, null);
  assert.equal(result?.baselineEvent, 1);
  assert.equal(result?.baselineValue, 100);
  assert.equal(result?.latestEvent, 3);
  assert.equal(result?.latestValue, 101.1);
  assert.ok(Math.abs((result?.delta ?? 0) - 1.1) < 1e-9);
});

test("teamValueSummary: a single finished gameweek -- baseline equals latest, delta is 0, not hidden", () => {
  const weeks = [makeWeek({ event: 5, value: 102 })];
  const result = teamValueSummary(weeks, null);
  assert.equal(result?.baselineEvent, 5);
  assert.equal(result?.latestEvent, 5);
  assert.equal(result?.delta, 0);
});

test("teamValueSummary: no squad supplied -- ownedPriceDrift is null, not zero (honestly unavailable, not a fabricated zero)", () => {
  const weeks = [makeWeek({ event: 1, value: 100 })];
  const result = teamValueSummary(weeks, null);
  assert.equal(result?.ownedPriceDrift, null);
});

test("teamValueSummary: an empty squad array (never null, but genuinely empty) also reports ownedPriceDrift as null", () => {
  const weeks = [makeWeek({ event: 1, value: 100 })];
  const result = teamValueSummary(weeks, []);
  assert.equal(result?.ownedPriceDrift, null);
});

test("teamValueSummary: a real squad sums priceChangeSinceStart across owned players -- a partial breakdown, not a reconciliation of delta", () => {
  const weeks = [makeWeek({ event: 1, value: 100 }), makeWeek({ event: 5, value: 103 })];
  const squad = [makePlayer({ id: 1, priceChangeSinceStart: 0.3 }), makePlayer({ id: 2, priceChangeSinceStart: -0.1 }), makePlayer({ id: 3, priceChangeSinceStart: 0.2 })];
  const result = teamValueSummary(weeks, squad);
  assert.ok(Math.abs((result?.ownedPriceDrift ?? 0) - 0.4) < 1e-9);
  // Deliberately does not assert ownedPriceDrift === delta -- a real transfer would make them
  // legitimately disagree, and that disagreement is expected, not a bug.
});
