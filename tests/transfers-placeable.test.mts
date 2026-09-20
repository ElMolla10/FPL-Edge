import assert from "node:assert/strict";
import test from "node:test";
import type { FplData, FplPlayer } from "../app/lib/fpl.ts";
import { bestTransfers, isPlaceableTransfer } from "../app/lib/transfers.ts";

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

test("isPlaceableTransfer: over-budget target is rejected even when selling price is below market", () => {
  const initial = squad();
  const out = initial.find(p => p.id === 21)!; // £6.0m MID
  // Official selling price is below current market (price rises), bank is tiny.
  const sellingPrices = new Map([[out.id, 5.5]]);
  const bank = 0.5;
  const expensive = makePlayer({
    id: 99, name: "Expensive", teamId: 99, teamName: "Expensive FC", teamShort: "EXP",
    positionId: 3, position: "Midfielder", positionShort: "MID",
    price: 6.1, epNext: 12, form: 9, pointsPerGame: 8, priorPointsPerGame: 8, priorExpectedGoals: 15, priorExpectedAssists: 12,
  });
  // Market-price fallacy: 6.1 <= 6.0 + 0.5 would look fine; selling-price truth: 6.1 > 5.5 + 0.5.
  const data = dataFor([...initial, expensive]);
  const result = isPlaceableTransfer(data, initial, out, expensive, bank, sellingPrices);
  assert.equal(result.placeable, false);
  if (!result.placeable) assert.equal(result.reason, "budget");
  const rows = bestTransfers(data, initial, bank, 1, 50, sellingPrices);
  assert.ok(!rows.some(row => row.incoming.id === expensive.id && row.out.id === out.id), "over-budget transfer must not appear in Transfers rankings");
});

test("isPlaceableTransfer: a 4th player from the same club is rejected", () => {
  const initial = squad();
  // Put three Arsenal (team 7) players in the squad already via DEF slots 11/12/13.
  initial[2] = makePlayer({ id: 11, name: "P11", teamId: 7, teamName: "Arsenal", teamShort: "ARS", positionId: 2, position: "Defender", positionShort: "DEF", price: 4.5, epNext: 3 });
  initial[3] = makePlayer({ id: 12, name: "P12", teamId: 7, teamName: "Arsenal", teamShort: "ARS", positionId: 2, position: "Defender", positionShort: "DEF", price: 4.5, epNext: 3 });
  initial[4] = makePlayer({ id: 13, name: "P13", teamId: 7, teamName: "Arsenal", teamShort: "ARS", positionId: 2, position: "Defender", positionShort: "DEF", price: 4.5, epNext: 3 });
  const out = initial.find(p => p.id === 21)!; // MID from a different club
  const fourth = makePlayer({
    id: 98, name: "Fourth Arsenal", teamId: 7, teamName: "Arsenal", teamShort: "ARS",
    positionId: 3, position: "Midfielder", positionShort: "MID",
    price: 6, epNext: 12, form: 9, pointsPerGame: 8, priorPointsPerGame: 8, priorExpectedGoals: 15, priorExpectedAssists: 12,
  });
  const data = dataFor([...initial, fourth]);
  const result = isPlaceableTransfer(data, initial, out, fourth, 5, new Map());
  assert.equal(result.placeable, false);
  if (!result.placeable) assert.equal(result.reason, "club-limit");
  const rows = bestTransfers(data, initial, 5, 1, 50);
  assert.ok(!rows.some(row => row.incoming.id === fourth.id), "4th same-club player must not appear in Transfers rankings");
});

test("isPlaceableTransfer: a position-breaking swap is rejected", () => {
  const initial = squad();
  const out = initial.find(p => p.id === 21)!; // MID
  const defender = makePlayer({
    id: 97, name: "Wrong Pos", teamId: 97, teamName: "Other FC", teamShort: "OTH",
    positionId: 2, position: "Defender", positionShort: "DEF",
    price: 5, epNext: 12, form: 9, pointsPerGame: 8, priorPointsPerGame: 8, priorExpectedGoals: 8, priorExpectedAssists: 8,
  });
  const data = dataFor([...initial, defender]);
  const result = isPlaceableTransfer(data, initial, out, defender, 10, new Map());
  assert.equal(result.placeable, false);
  if (!result.placeable) assert.equal(result.reason, "position");
  const rows = bestTransfers(data, initial, 10, 1, 50);
  assert.ok(!rows.some(row => row.out.id === out.id && row.incoming.id === defender.id), "MID→DEF must never appear in Transfers rankings");
  assert.ok(rows.every(row => row.out.positionId === row.incoming.positionId), "every ranked transfer must keep position");
});

test("isPlaceableTransfer: a valid affordable same-position swap is kept", () => {
  const initial = squad();
  const out = initial.find(p => p.id === 21)!; // £6.0m MID
  const upgrade = makePlayer({
    id: 96, name: "Upgrade", teamId: 96, teamName: "Upgrade FC", teamShort: "UPG",
    positionId: 3, position: "Midfielder", positionShort: "MID",
    price: 6.5, epNext: 12, form: 9, pointsPerGame: 8, priorPointsPerGame: 8, priorExpectedGoals: 15, priorExpectedAssists: 12,
  });
  const sellingPrices = new Map([[out.id, 6.0]]);
  const bank = 1.0; // 6.5 <= 6.0 + 1.0
  const data = dataFor([...initial, upgrade]);
  const result = isPlaceableTransfer(data, initial, out, upgrade, bank, sellingPrices);
  assert.equal(result.placeable, true);
  const rows = bestTransfers(data, initial, bank, 1, 50, sellingPrices);
  assert.ok(rows.some(row => row.incoming.id === upgrade.id && row.out.id === out.id), "legal affordable upgrade must remain visible on Transfers");
});

test("isPlaceableTransfer: same-club replacement at the club cap stays legal", () => {
  const initial = squad();
  initial[2] = makePlayer({ id: 11, name: "P11", teamId: 7, teamName: "Arsenal", teamShort: "ARS", positionId: 2, position: "Defender", positionShort: "DEF", price: 4.5, epNext: 2 });
  initial[3] = makePlayer({ id: 12, name: "P12", teamId: 7, teamName: "Arsenal", teamShort: "ARS", positionId: 2, position: "Defender", positionShort: "DEF", price: 4.5, epNext: 2 });
  initial[4] = makePlayer({ id: 13, name: "P13", teamId: 7, teamName: "Arsenal", teamShort: "ARS", positionId: 2, position: "Defender", positionShort: "DEF", price: 4.5, epNext: 2 });
  const out = initial[4]; // selling one Arsenal DEF
  const replacement = makePlayer({
    id: 95, name: "ARS Upgrade", teamId: 7, teamName: "Arsenal", teamShort: "ARS",
    positionId: 2, position: "Defender", positionShort: "DEF",
    price: 4.5, epNext: 10, form: 8, pointsPerGame: 7, priorPointsPerGame: 7, priorExpectedGoals: 8, priorExpectedAssists: 8,
  });
  const data = dataFor([...initial, replacement]);
  const result = isPlaceableTransfer(data, initial, out, replacement, 0, new Map());
  assert.equal(result.placeable, true, "replacing one of three same-club players with another from that club must stay legal");
});
