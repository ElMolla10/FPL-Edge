import assert from "node:assert/strict";
import test from "node:test";
import { FplData, FplPlayer } from "../app/lib/fpl.ts";
import { bestTransfers } from "../app/lib/transfers.ts";

// Planned chips must not mutate transfer-engine ranking EP (chips are separate; no double-count).
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

function makePlayer(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1, name: "Player", firstName: "Test", secondName: "Player", teamId: 1, teamName: "Test FC", teamShort: "TFC", positionId: 3, position: "Midfielder", positionShort: "MID", price: 5, status: "a", chance: null,
    epNext: 3, form: 3, pointsPerGame: 3, priorPointsPerGame: 3, priorMinutes: 2500, priorStarts: 30, priorExpectedGoals: 3, priorExpectedAssists: 3, priorBonus: 10, priorSaves: 0, priorPenaltiesSaved: 0, priorDefensiveContribution: 100, priorSource: "official-pl-history",
    totalPoints: 0, eventPoints: 0, eventMinutes: 0, eventBonus: 0, eventDefensiveContribution: 0, selectedBy: 10, priceChange: 0, priceProjectionToday: 0, priceChangeSinceStart: 0, priceOutlook: [], transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0, expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 2700, starts: 30, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0, penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0, penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
    ...overrides,
  };
}

function squad(): FplPlayer[] {
  const player = (id: number, positionId: number, positionShort: FplPlayer["positionShort"], price = 5, epNext = 3) =>
    makePlayer({ id, name: `P${id}`, teamId: id, teamName: `Team ${id}`, teamShort: `T${id}`, positionId, positionShort, position: positionShort, price, epNext });
  return [
    player(1, 1, "GKP", 4.5), player(2, 1, "GKP", 4.5),
    ...[11, 12, 13, 14, 15].map(id => player(id, 2, "DEF", 4.5)),
    ...[21, 22, 23, 24, 25].map(id => player(id, 3, "MID", 6)),
    ...[31, 32, 33].map(id => player(id, 4, "FWD", 7)),
  ];
}

function dataFor(players: FplPlayer[], count = 1): FplData {
  const events = Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `Gameweek ${index + 1}`, deadline: new Date(Date.now() + (index + 1) * 86400000).toISOString(), current: false, next: index === 0, finished: false, dataChecked: false }));
  const clubIds = [...new Set(players.map(p => p.teamId))];
  const fixtures = events.flatMap(event => clubIds.map((teamId, index) => ({ id: event.id * 1000 + index, event: event.id, teamH: teamId, teamA: 1000 + teamId, teamHDifficulty: 3, teamADifficulty: 3, finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null })));
  return { updatedAt: new Date().toISOString(), source: "test", seasonStatsThrough: 0, players, fixtures, events, teams: clubIds.map(id => ({ id, name: `Team ${id}`, short: `T${id}` })), rules: { budget: 100, squadSize: 15, teamLimit: 3, positions: [{ id: 1, name: "Goalkeeper", short: "GKP", squad: 2, minPlay: 1, maxPlay: 1 }, { id: 2, name: "Defender", short: "DEF", squad: 5, minPlay: 3, maxPlay: 5 }, { id: 3, name: "Midfielder", short: "MID", squad: 5, minPlay: 2, maxPlay: 5 }, { id: 4, name: "Forward", short: "FWD", squad: 3, minPlay: 1, maxPlay: 3 }] } };
}

test.beforeEach(() => { (globalThis.localStorage as any).clear(); });

test("bestTransfers: planned Triple Captain does not change ranking EP (chips separate, no double-count)", () => {
  const initial = squad();
  const upgrade = makePlayer({ id: 99, name: "Upgrade", teamId: 99, teamName: "Upgrade FC", teamShort: "UPG", positionId: 3, position: "Midfielder", positionShort: "MID", price: 6, epNext: 20, form: 20, pointsPerGame: 20, priorExpectedGoals: 30, priorExpectedAssists: 30, minutes: 2700, starts: 30, priorMinutes: 3000 });
  const data = dataFor([...initial, upgrade], 1);

  const withoutPlan = bestTransfers(data, initial, 5, 1, 30);
  const row1 = withoutPlan.find(r => r.incoming.id === upgrade.id)!;
  assert.ok(row1, "the high-projection upgrade must appear as a candidate");

  localStorage.setItem("fpl-edge-planned-chips", JSON.stringify([{ event: 1, chip: "Triple Captain" }]));
  const withPlan = bestTransfers(data, initial, 5, 1, 30);
  const row2 = withPlan.find(r => r.incoming.id === upgrade.id)!;
  assert.ok(row2);
  assert.equal(row2.gain1, row1.gain1, "TC must not fold into transfer NET ranking");
  assert.equal(row2.netEv5, row1.netEv5);
});

test("bestTransfers: no planned chips in storage behaves exactly as before -- gain1 is unaffected", () => {
  const initial = squad();
  const upgrade = makePlayer({ id: 99, name: "Upgrade", teamId: 99, teamName: "Upgrade FC", teamShort: "UPG", positionId: 3, position: "Midfielder", positionShort: "MID", price: 6, epNext: 9, form: 8, pointsPerGame: 7, minutes: 2700, starts: 30, priorMinutes: 2500 });
  const data = dataFor([...initial, upgrade], 1);
  const a = bestTransfers(data, initial, 5, 1, 30);
  localStorage.setItem("fpl-edge-planned-chips", "[]");
  const b = bestTransfers(data, initial, 5, 1, 30);
  const rowA = a.find(r => r.incoming.id === upgrade.id)!, rowB = b.find(r => r.incoming.id === upgrade.id)!;
  assert.equal(rowA.gain1, rowB.gain1);
});

test("bestTransfers: a planned Wildcard/Free Hit for event 1 leaves gain1 completely unchanged -- chips separate", () => {
  const initial = squad();
  const upgrade = makePlayer({ id: 99, name: "Upgrade", teamId: 99, teamName: "Upgrade FC", teamShort: "UPG", positionId: 3, position: "Midfielder", positionShort: "MID", price: 6, epNext: 9, form: 8, pointsPerGame: 7, minutes: 2700, starts: 30, priorMinutes: 2500 });
  const data = dataFor([...initial, upgrade], 1);
  const withoutPlan = bestTransfers(data, initial, 5, 1, 30);
  localStorage.setItem("fpl-edge-planned-chips", JSON.stringify([{ event: 1, chip: "Wildcard" }]));
  const withPlan = bestTransfers(data, initial, 5, 1, 30);
  const rowA = withoutPlan.find(r => r.incoming.id === upgrade.id)!, rowB = withPlan.find(r => r.incoming.id === upgrade.id)!;
  assert.equal(rowA.gain1, rowB.gain1);
});
