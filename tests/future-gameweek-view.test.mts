import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FutureGameweekView } from "../app/components/CoachApp.tsx";
import { FplData, FplPlayer } from "../app/lib/fpl.ts";
import { writePlannedChips } from "../app/lib/chip-portfolio.ts";

// Same minimal in-memory localStorage stand-in as persistence.test.mts/transfers-planned-chips.test.mts --
// plannedChipFor(readPlannedChips(),...) needs a real localStorage, not undefined.
function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
}
(globalThis as any).localStorage = memoryStorage();

function makePlayer(overrides: Partial<FplPlayer> & { id: number; name: string }): FplPlayer {
  return {
    firstName: overrides.name, secondName: "", teamId: 1, teamName: "Test FC", teamShort: "TFC",
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

// One heavily-favoured captain candidate (huge form/priorPointsPerGame/minutes) so the projection
// gap over the rest of the squad is unambiguous -- both for bestXi's captain pick and for
// chipScoresForEvent's tripleCaptain score, without needing to reverse-engineer either formula's
// exact coefficients (same technique tests/optimizer-engine.test.mts's makeRiskySquad already uses).
function makeSquad(): FplPlayer[] {
  const filler = (id: number, positionShort: FplPlayer["positionShort"], positionId: number) =>
    makePlayer({ id, name: `Filler${id}`, teamId: id, positionShort, positionId, form: 2, priorPointsPerGame: 2 });
  const star = makePlayer({
    id: 21, name: "Star", teamId: 21, positionShort: "MID", positionId: 3,
    form: 9, priorPointsPerGame: 9, priorMinutes: 3400, priorStarts: 38,
    priorExpectedGoals: 20, priorExpectedAssists: 15, epNext: 9,
  });
  return [
    makePlayer({ id: 1, name: "Filler1", teamShort: "T1", teamId: 1, positionShort: "GKP", positionId: 1 }),
    makePlayer({ id: 2, name: "Filler2", teamShort: "T2", teamId: 2, positionShort: "GKP", positionId: 1 }),
    ...[11, 12, 13, 14, 15].map((id) => filler(id, "DEF", 2)),
    star,
    ...[22, 23, 24, 25].map((id) => filler(id, "MID", 3)),
    ...[31, 32, 33].map((id) => filler(id, "FWD", 4)),
  ];
}

function makeData(squad: FplPlayer[]): FplData {
  const fixtures = squad.map((p) => ({
    id: p.teamId, event: 6, teamH: p.teamId, teamA: 900 + p.teamId, teamHDifficulty: 2, teamADifficulty: 2,
    finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null,
  }));
  return {
    updatedAt: new Date().toISOString(), source: "test", seasonStatsThrough: 0,
    players: squad, fixtures,
    events: [{ id: 6, name: "Gameweek 6", deadline: new Date(Date.now() + 5 * 86400000).toISOString(), current: false, next: false, finished: false, dataChecked: false }],
    teams: [...new Set(squad.map((p) => p.teamId))].map((id) => ({ id, name: `Team ${id}`, short: `T${id}` })),
    rules: {
      budget: 100, squadSize: 15, teamLimit: 3,
      positions: [
        { id: 1, name: "Goalkeeper", short: "GKP", squad: 2, minPlay: 1, maxPlay: 1 },
        { id: 2, name: "Defender", short: "DEF", squad: 5, minPlay: 3, maxPlay: 5 },
        { id: 3, name: "Midfielder", short: "MID", squad: 5, minPlay: 2, maxPlay: 5 },
        { id: 4, name: "Forward", short: "FWD", squad: 3, minPlay: 1, maxPlay: 3 },
      ],
    },
  };
}

test("FutureGameweekView: shows the captain badge on the right XI card, a real substitution-order bench, and a Triple Captain verdict when unplanned and strong", () => {
  const squad = makeSquad();
  const data = makeData(squad);
  const event = data.events[0];

  const html = renderToStaticMarkup(createElement(FutureGameweekView, {
    data, event, squad, tab: "Pitch", setTab: () => {}, selected: null, setSelected: () => {}, bank: 0,
  }));

  assert.match(html, /<b>Star<em>C<\/em><\/b>/, "the projected-best player must carry the captain badge, not just any XI player");
  assert.doesNotMatch(html, /<b>Filler22<em>C<\/em><\/b>/, "a non-captain XI player must not also get the badge");

  assert.match(html, /class="coach-bench"/, "a bench section must render on the Pitch tab");
  assert.match(html, /<i>1<\/i>/, "bench substitution order must start at 1");

  assert.match(html, /gw-chip-note">This looks like a good week for Triple Captain · Star/, "an unplanned, strongly-favoured Triple Captain week must show the verdict, naming the real captain");
});

test("FutureGameweekView: suppresses the Triple Captain verdict when Triple Captain is already the planned chip for this event", () => {
  const squad = makeSquad();
  const data = makeData(squad);
  const event = data.events[0];
  writePlannedChips([{ event: event.id, chip: "Triple Captain" }]);

  const html = renderToStaticMarkup(createElement(FutureGameweekView, {
    data, event, squad, tab: "Pitch", setTab: () => {}, selected: null, setSelected: () => {}, bank: 0,
  }));

  assert.doesNotMatch(html, /gw-chip-note/, "the live verdict must not repeat what the PLANNED CHIP badge already says");
  assert.match(html, /gw-planned-chip/, "the existing planned-chip badge must still render");
});
