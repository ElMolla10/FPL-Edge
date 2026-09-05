import assert from "node:assert/strict";
import test from "node:test";
import { FplData, FplEvent, FplFixture } from "../app/lib/fpl.ts";
import { computeClubFixtureRows } from "../app/lib/fixture-difficulty.ts";
import type { TeamQualityProfile } from "../app/lib/team-quality.ts";

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

function makeQuality(overrides: Partial<TeamQualityProfile> = {}): TeamQualityProfile {
  return {
    id: 1, attackHome: 1, attackAway: 1, defenceHome: 1, defenceAway: 1,
    effectiveAttackHome: 1, effectiveAttackAway: 1, effectiveDefenceHome: 1, effectiveDefenceAway: 1,
    confidence: 1, matches: 38, currentWeight: 1, plPriorCoverage: 1, lowPlContinuity: false,
    source: "official-prior+current-pl", modelVersion: "test",
    ...overrides,
  };
}

function makeEvent(id: number, daysFromNow: number, finished = false): FplEvent {
  return { id, name: `Gameweek ${id}`, deadline: new Date(Date.now() + daysFromNow * 86400000).toISOString(), current: false, next: false, finished, dataChecked: false };
}

function makeData(overrides: Partial<FplData> = {}): FplData {
  return {
    updatedAt: new Date().toISOString(), source: "test", seasonStatsThrough: 0, players: [],
    fixtures: [], events: [], rules: { budget: 100, squadSize: 15, teamLimit: 3, positions: [] },
    teams: [], ...overrides,
  } as FplData;
}

// --- computeClubFixtureRows ---

test("computeClubFixtureRows: a team with no fixture in an event returns the real BLANK sentinel", () => {
  const teamA = { id: 1, name: "Team A", short: "TMA", quality: makeQuality() };
  const teamB = { id: 2, name: "Team B", short: "TMB", quality: makeQuality() };
  const data = makeData({
    teams: [teamA, teamB],
    events: [makeEvent(1, 3)],
    fixtures: [], // no fixture at all for event 1
  });
  const rows = computeClubFixtureRows(data, 8);
  const rowA = rows.find(r => r.team.id === 1)!;
  assert.deepEqual(rowA.cells[0], { label: "BLANK", attack: 5, defence: 5, attackMultiplier: 0, defenceMultiplier: 0 });
});

// Hand-computed from the real formula with neutral (1.0) quality on both sides, to prove the
// extracted function reproduces the exact real arithmetic, not an approximation:
// attackMultiplier = ownAttack/max(.6,oppDefence) * (home?1.04:.96); defenceMultiplier mirrors
// with 1.05/.94; difficulty(x) = clamp(3-(x-1)*6, 1, 5).
test("computeClubFixtureRows: home team gets the real home multiplier (1.04/1.05), away team the real away multiplier (0.96/0.94) -- distinguishing home/away, not symmetric", () => {
  const teamA = { id: 1, name: "Team A", short: "TMA", quality: makeQuality() };
  const teamB = { id: 2, name: "Team B", short: "TMB", quality: makeQuality() };
  const fixture: FplFixture = { id: 1, event: 1, teamH: 1, teamA: 2, teamHDifficulty: 3, teamADifficulty: 3, finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null };
  const data = makeData({ teams: [teamA, teamB], events: [makeEvent(1, 3)], fixtures: [fixture] });
  const rows = computeClubFixtureRows(data, 8);
  const rowA = rows.find(r => r.team.id === 1)!.cells[0]; // home
  const rowB = rows.find(r => r.team.id === 2)!.cells[0]; // away
  assert.ok(close(rowA.attackMultiplier, 1.04), `home attackMultiplier expected 1.04, got ${rowA.attackMultiplier}`);
  assert.ok(close(rowA.defenceMultiplier, 1.05), `home defenceMultiplier expected 1.05, got ${rowA.defenceMultiplier}`);
  assert.ok(close(rowA.attack, 2.76), `home difficulty(attack) expected 2.76, got ${rowA.attack}`);
  assert.ok(close(rowA.defence, 2.7), `home difficulty(defence) expected 2.7, got ${rowA.defence}`);
  assert.ok(close(rowB.attackMultiplier, .96), `away attackMultiplier expected 0.96, got ${rowB.attackMultiplier}`);
  assert.ok(close(rowB.defenceMultiplier, .94), `away defenceMultiplier expected 0.94, got ${rowB.defenceMultiplier}`);
  assert.equal(rowA.label, "TMB H");
  assert.equal(rowB.label, "TMA A");
});

test("computeClubFixtureRows: a double-gameweek averages difficulty across both real fixtures in the same event", () => {
  const teamA = { id: 1, name: "Team A", short: "TMA", quality: makeQuality() };
  const teamB = { id: 2, name: "Team B", short: "TMB", quality: makeQuality() };
  const teamC = { id: 3, name: "Team C", short: "TMC", quality: makeQuality() };
  // Team A plays home vs B (attack difficulty 2.76) AND away vs C (attack difficulty 3.24) in the
  // same real gameweek -- average should be exactly 3.0.
  const fixtures: FplFixture[] = [
    { id: 1, event: 1, teamH: 1, teamA: 2, teamHDifficulty: 3, teamADifficulty: 3, finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null },
    { id: 2, event: 1, teamH: 3, teamA: 1, teamHDifficulty: 3, teamADifficulty: 3, finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null },
  ];
  const data = makeData({ teams: [teamA, teamB, teamC], events: [makeEvent(1, 3)], fixtures });
  const rows = computeClubFixtureRows(data, 8);
  const rowA = rows.find(r => r.team.id === 1)!.cells[0];
  assert.ok(close(rowA.attack, 3.0), `double-gameweek average expected exactly 3.0, got ${rowA.attack}`);
});

test("computeClubFixtureRows: swing is the real early-half-minus-late-half attack average, not a fabricated trend", () => {
  const teamA = { id: 1, name: "Team A", short: "TMA", quality: makeQuality() };
  const teamB = { id: 2, name: "Team B", short: "TMB", quality: makeQuality() };
  // Event 1: A home (attack difficulty 2.76, the "easy" half). Event 2: A away (attack difficulty
  // 3.24, the "hard" half). With exactly 2 events, split=1, so swing = cell0.attack - cell1.attack.
  const fixtures: FplFixture[] = [
    { id: 1, event: 1, teamH: 1, teamA: 2, teamHDifficulty: 3, teamADifficulty: 3, finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null },
    { id: 2, event: 2, teamH: 2, teamA: 1, teamHDifficulty: 3, teamADifficulty: 3, finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null },
  ];
  const data = makeData({ teams: [teamA, teamB], events: [makeEvent(1, 3), makeEvent(2, 10)], fixtures });
  const rows = computeClubFixtureRows(data, 8);
  const rowA = rows.find(r => r.team.id === 1)!;
  assert.ok(close(rowA.swing, 2.76 - 3.24), `swing expected ${2.76 - 3.24}, got ${rowA.swing}`);
});

test("computeClubFixtureRows: the real horizon parameter narrows the real event window via futureEvents, not an invented cutoff", () => {
  const teamA = { id: 1, name: "Team A", short: "TMA", quality: makeQuality() };
  const data = makeData({ teams: [teamA], events: [makeEvent(1, 3), makeEvent(2, 10), makeEvent(3, 17)], fixtures: [] });
  assert.equal(computeClubFixtureRows(data, 1)[0].cells.length, 1);
  assert.equal(computeClubFixtureRows(data, 8)[0].cells.length, 3, "only 3 real future events exist, even though horizon=8 was requested");
});

test("computeClubFixtureRows: a finished event is real-excluded from the window, same as futureEvents everywhere else in this app", () => {
  const teamA = { id: 1, name: "Team A", short: "TMA", quality: makeQuality() };
  const data = makeData({ teams: [teamA], events: [makeEvent(1, -3, true), makeEvent(2, 3)], fixtures: [] });
  assert.equal(computeClubFixtureRows(data, 8)[0].cells.length, 1);
});
