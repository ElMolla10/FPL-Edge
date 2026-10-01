import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { FplData, FplPlayer } from "../app/lib/fpl.ts";
import { selectBestDecision } from "../app/lib/transfers.ts";
import { buildWeeklyDecision, formatNet, narrateWeeklyDecision, WEEKLY_DECISION_SOURCE } from "../app/lib/weekly-decision.ts";
import * as core from "../app/components/coach/CoachCore.tsx";
import { createOptimizer } from "../app/lib/optimizer.ts";

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
}
(globalThis as unknown as { localStorage: unknown }).localStorage = memoryStorage();

function makePlayer(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1, name: "Player", firstName: "Test", secondName: "Player", teamId: 1, teamName: "Test FC", teamShort: "TFC", positionId: 3, position: "Midfielder", positionShort: "MID", price: 5, status: "a", chance: null,
    epNext: 3, form: 3, pointsPerGame: 3, priorPointsPerGame: 3, priorMinutes: 2500, priorStarts: 30, priorExpectedGoals: 3, priorExpectedAssists: 3, priorBonus: 10, priorSaves: 0, priorPenaltiesSaved: 0, priorDefensiveContribution: 100, priorSource: "official-pl-history",
    totalPoints: 0, eventPoints: 0, eventMinutes: 0, eventBonus: 0, eventDefensiveContribution: 0, selectedBy: 10, priceChange: 0, priceProjectionToday: 0, priceChangeSinceStart: 0, priceOutlook: [], transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0, expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 0, starts: 0, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0, penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0, penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
    ...overrides,
  };
}

function squad(): FplPlayer[] {
  const player = (id: number, positionId: number, positionShort: FplPlayer["positionShort"], price = 5, epNext = 3, teamId = id) =>
    makePlayer({ id, name: `P${id}`, teamId, teamName: `Team ${teamId}`, teamShort: `T${teamId}`, positionId, positionShort, position: positionShort, price, epNext });
  return [
    player(1, 1, "GKP", 4.5), player(2, 1, "GKP", 4.5),
    ...[11, 12, 13, 14, 15].map(id => player(id, 2, "DEF", 4.5)),
    ...[21, 22, 23, 24, 25].map(id => player(id, 3, "MID", 6)),
    ...[31, 32, 33].map(id => player(id, 4, "FWD", 7)),
  ];
}

function dataFor(players: FplPlayer[], count = 3): FplData {
  const events = Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `Gameweek ${index + 1}`, deadline: new Date(Date.now() + (index + 1) * 86400000).toISOString(), current: false, next: index === 0, finished: false, dataChecked: false }));
  const clubIds = [...new Set(players.map(p => p.teamId))];
  const fixtures = events.flatMap(event => clubIds.map((teamId, index) => ({ id: event.id * 1000 + index, event: event.id, teamH: teamId, teamA: 1000 + teamId, teamHDifficulty: 3, teamADifficulty: 3, finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null })));
  return { updatedAt: new Date().toISOString(), source: "test", seasonStatsThrough: 0, players, fixtures, events, teams: clubIds.map(id => ({ id, name: `Team ${id}`, short: `T${id}` })), rules: { budget: 100, squadSize: 15, teamLimit: 3, positions: [{ id: 1, name: "Goalkeeper", short: "GKP", squad: 2, minPlay: 1, maxPlay: 1 }, { id: 2, name: "Defender", short: "DEF", squad: 5, minPlay: 3, maxPlay: 5 }, { id: 3, name: "Midfielder", short: "MID", squad: 5, minPlay: 2, maxPlay: 5 }, { id: 4, name: "Forward", short: "FWD", squad: 3, minPlay: 1, maxPlay: 3 }] } };
}


const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// The three surfaces, reduced to exactly what each one renders from the canonical object.
function surfaces(data: FplData, squadPlayers: FplPlayer[], bank: number, ft: number) {
  const a = core.analysis(data, squadPlayers)!;
  const sp = new Map<number, number>();
  const rows = core.rankRowsForWeeklyDecision(data, squadPlayers, bank, ft, sp, false);
  const ctx = { gameweek: a.first, freeTransfers: ft, freeTransferSource: "assumed" as const, bank, captainId: core.decisionCaptainId(a, null) };
  const home = buildWeeklyDecision(rows, ctx);
  const transfers = buildWeeklyDecision(core.rankRowsForWeeklyDecision(data, squadPlayers, bank, ft, sp, false), ctx);
  const coach = buildWeeklyDecision(core.rankRowsForWeeklyDecision(data, squadPlayers, bank, ft, sp, false), ctx);
  return { a, rows, home, transfers, coach, coachText: narrateWeeklyDecision(coach) };
}

function makeFixture() {
  const base = squad();
  const star = makePlayer({ id: 99, name: "Star", teamId: 99, teamName: "Star FC", teamShort: "STR", positionId: 3, position: "Midfielder", positionShort: "MID", price: 6, epNext: 12, form: 10, pointsPerGame: 9, priorPointsPerGame: 9, priorExpectedGoals: 18, priorExpectedAssists: 12 });
  // Mild upgrade that cannot clear a −4 hit vs HOLD (same fixture shape as transfer-engine.test).
  const mild = makePlayer({ id: 98, name: "Mild", teamId: 98, teamName: "Mild FC", teamShort: "MIL", positionId: 3, position: "Midfielder", positionShort: "MID", price: 6.2, epNext: 3.4, form: 3.2, pointsPerGame: 3.2, priorPointsPerGame: 3.2, minutes: 2700, starts: 30, priorMinutes: 2500, chance: 100, status: "a" });
  return { makeData: dataFor([...base, star], 5), holdData: dataFor([...base, mild], 5), squad: base };
}

test("canonical decision: Home action === Transfers action === Coach action (MAKE fixture)", () => {
  const f = makeFixture();
  const s = surfaces(f.makeData, f.squad, 1, 1);
  assert.equal(s.home.action, s.transfers.action);
  assert.equal(s.transfers.action, s.coach.action);
  assert.equal(s.home.outPlayerId, s.transfers.outPlayerId);
  assert.equal(s.home.inPlayerId, s.coach.inPlayerId);
  assert.equal(s.home.source, WEEKLY_DECISION_SOURCE);
  assert.match(s.coachText, new RegExp(`^${s.coach.action}`));
});

test("canonical decision: net5gw identical and printed with the same rounding on all three surfaces", () => {
  const f = makeFixture();
  const s = surfaces(f.makeData, f.squad, 1, 1);
  assert.equal(s.home.net5gw, s.transfers.net5gw);
  assert.equal(s.transfers.net5gw, s.coach.net5gw);
  const printed = formatNet(s.transfers.net5gw);
  assert.equal(formatNet(s.home.net5gw), printed);
  if (s.coach.action === "MAKE") assert.ok(s.coachText.includes(`${printed} 5-GW NET vs HOLD`), s.coachText);
  // documented rounding: signed, 1 dp, no "-0.0"
  assert.equal(formatNet(9.249), "+9.2");
  assert.equal(formatNet(-0.04), "+0.0");
  assert.equal(formatNet(-8.06), "-8.1");
});

test("canonical decision follows the engine: MAKE when it says MAKE, HOLD when it says HOLD", () => {
  const f = makeFixture();
  for (const [data, ft] of [[f.makeData, 1], [f.holdData, 0], [f.holdData, 1]] as const) {
    const a = core.analysis(data, f.squad)!;
    const engineRows = core.rankTransfersForBestDecision(data, f.squad, 1, ft, new Map(), createOptimizer(data, "Balanced 5 GWs", "Balanced", "Maximum xPts"));
    const engine = selectBestDecision(engineRows);
    const engineSaysHold = !engine || engine.isHold === true || engine.classification === "HOLD";
    const d = buildWeeklyDecision(engineRows, { gameweek: a.first, freeTransfers: ft, freeTransferSource: "assumed", bank: 1, captainId: null });
    assert.equal(d.action, engineSaysHold ? "HOLD" : "MAKE");
    if (d.action === "HOLD") { assert.equal(d.outPlayerId, null); assert.equal(d.inPlayerId, null); assert.equal(d.net5gw, 0); }
    else { assert.equal(d.outPlayerId, engine!.out.id); assert.equal(d.inPlayerId, engine!.incoming.id); }
  }
  // The star upgrade fixture must actually exercise MAKE, the bare squad HOLD.
  assert.equal(surfaces(f.makeData, f.squad, 1, 1).home.action, "MAKE");
  const hold = surfaces(f.holdData, f.squad, 1, 0);
  assert.equal(hold.home.action, "HOLD");
  assert.equal(hold.transfers.action, hold.coach.action);
  assert.match(hold.coachText, /^HOLD/);
});

test("captain on Home matches the captain used in the projected GW total", () => {
  const f = makeFixture();
  const s = surfaces(f.makeData, f.squad, 1, 1);
  const model = s.a.xi.captain ?? s.a.xi.players[0];
  assert.equal(s.home.captainId, model.id);
  assert.ok(s.a.xi.players.some(p => p.id === s.home.captainId));
  // A stored captain choice changes the canonical captain (and therefore the projected total) together.
  const other = s.a.xi.players.find(p => p.id !== model.id)!;
  localStorage.setItem(`fpl-edge-captain-${s.a.first}`, String(other.id));
  try { assert.equal(core.decisionCaptainId(s.a, null), other.id); }
  finally { localStorage.removeItem(`fpl-edge-captain-${s.a.first}`); }
  const overview = read("app/components/CoachApp.tsx");
  assert.match(overview, /canonicalCaptainId=wd\?\.captainId/);
  assert.match(overview, /captainTerm=playerProjection\(activeCaptain/);
});

test("Home, Transfers and Coach read only the canonical decision (no private pipelines)", () => {
  const overviewSrc = read("app/components/CoachApp.tsx");
  const overview = overviewSrc.slice(overviewSrc.indexOf("function Overview("), overviewSrc.indexOf("function WhatChanged("));
  const transfers = read("app/components/coach/TransfersPanel.tsx");
  const coach = read("app/components/coach/CoachPanel.tsx");
  for (const [name, src] of [["Overview", overview], ["Transfers", transfers], ["Coach", coach]] as const) {
    assert.match(src, /useWeeklyDecision\(/, `${name} must use useWeeklyDecision`);
    assert.doesNotMatch(src, /selectBestDecision\(|selectPrimaryTransfer\(moves\)|rankTransfersForBestDecision\(/, `${name} must not pick its own decision`);
  }
  assert.doesNotMatch(overview, /mode:"shallow"/, "Home must not paint a shallow second call");
  assert.match(overview, /FT assumed: \$\{fts\}/);
  assert.match(coach, /narrateWeeklyDecision\(weekly\.decision\)/);
  // Demo safety: the canonical path never writes storage.
  const coreSrc = read("app/components/coach/CoachCore.tsx");
  const hook = coreSrc.slice(coreSrc.indexOf("Canonical weekly decision"));
  assert.doesNotMatch(hook, /localStorage\.setItem|persist\(/);
});
