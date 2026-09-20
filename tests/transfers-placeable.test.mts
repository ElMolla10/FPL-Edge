import assert from "node:assert/strict";
import test from "node:test";
import type { FplData, FplPlayer } from "../app/lib/fpl.ts";
import { bestTransfers, isPlaceableTransfer } from "../app/lib/transfers.ts";
import { deriveSandboxFinancialContext } from "../app/lib/squad-comparison.ts";

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


test("regression: O'Nien-like cheap DEF → expensive DEF is rejected when official bank cannot cover the gap, even if budget-minus-market would invent ITB", () => {
  // Live prices that triggered the bug report: O'Nien ~£3.9m → Tarkowski ~£6.1m needs ~£2.2m.
  // A cheap 15-man market value leaves budget-minus-market ITB huge (~£18m+), which wrongly made
  // the swap look placeable while Mohamed's real ITB could not cover it.
  const initial = squad();
  const outIdx = initial.findIndex(p => p.positionShort === "DEF");
  const onien = makePlayer({
    id: 539, name: "O'Nien", teamId: 20, teamName: "Sunderland", teamShort: "SUN",
    positionId: 2, position: "Defender", positionShort: "DEF",
    price: 3.9, epNext: 2,
  });
  initial[outIdx] = onien;
  // Keep squad market value low so the OLD fallback would invent large ITB.
  for (const player of initial) {
    if (player.id !== onien.id && player.price > 5) {
      player.price = 4.5;
    }
  }
  const tarkowski = makePlayer({
    id: 229, name: "Tarkowski", teamId: 9, teamName: "Everton", teamShort: "EVE",
    positionId: 2, position: "Defender", positionShort: "DEF",
    price: 6.1, epNext: 8, form: 8, pointsPerGame: 6, priorExpectedGoals: 8, priorExpectedAssists: 5,
  });
  const data = dataFor([...initial, tarkowski]);
  const manager = {
    bank: 0.1,
    // Deliberately incomplete / mismatched picks — the failure mode that forced current-price ITB.
    picks: initial.slice(0, 10).map((player, index) => ({
      elementId: player.id,
      position: index + 1,
      multiplier: 1,
      isCaptain: false,
      isViceCaptain: false,
      sellingPrice: player.price,
    })),
  };
  const finance = deriveSandboxFinancialContext(initial, data.rules.budget, manager as never);
  assert.equal(finance.baselineBank, 0.1, "official bank must be preserved despite incomplete picks");
  assert.notEqual(finance.source, "current-price-assumption");
  const assumedBank = Math.max(0, data.rules.budget - initial.reduce((sum, player) => sum + player.price, 0));
  assert.ok(assumedBank > 2.2, "sanity: budget-minus-market would have been large enough to wrongly afford Tarkowski");
  const gate = isPlaceableTransfer(data, initial, onien, tarkowski, finance.baselineBank, finance.baselineSellingPrices);
  assert.equal(gate.placeable, false);
  if (!gate.placeable) assert.equal(gate.reason, "budget");
  const rows = bestTransfers(data, initial, finance.baselineBank, 1, 80, finance.baselineSellingPrices);
  assert.ok(!rows.some(row => row.out.id === onien.id && row.incoming.id === tarkowski.id), "O'Nien→Tarkowski must not appear in Actionable/ranked Transfers when ITB cannot cover it");
});

test("isPlaceableTransfer: non-finite bank is treated as 0 so NaN cannot pass every swap", () => {
  const initial = squad();
  const out = initial.find(p => p.positionShort === "MID")!;
  const expensive = makePlayer({
    id: 88, name: "Expensive", teamId: 88, teamName: "X FC", teamShort: "XFC",
    positionId: 3, position: "Midfielder", positionShort: "MID",
    price: out.price + 3, epNext: 10,
  });
  const data = dataFor([...initial, expensive]);
  const gate = isPlaceableTransfer(data, initial, out, expensive, Number.NaN, new Map());
  assert.equal(gate.placeable, false);
  if (!gate.placeable) assert.equal(gate.reason, "budget");
});

test("regression: risen DEF sale uses floor(half rises) so now+bank affordability cannot mark ACTIONABLE", () => {
  // Thomas-like exact boundary with a risen seller: market 4.2 + bank 1.9 = 6.1 would "fit"
  // Tarkowski at 6.1, but purchase was 4.0 → selling 4.1 → 4.1+1.9=6.0 < 6.1 → reject.
  const initial = squad();
  const outIdx = initial.findIndex(p => p.positionShort === "DEF");
  const risen = makePlayer({
    id: 173,
    name: "ThomasRisen",
    teamId: 15,
    teamName: "Coventry",
    teamShort: "COV",
    positionId: 2,
    position: "Defender",
    positionShort: "DEF",
    price: 4.2,
    priceChangeSinceStart: 0.2,
    epNext: 2,
  });
  initial[outIdx] = risen;
  const tarkowski = makePlayer({
    id: 229,
    name: "Tarkowski",
    teamId: 9,
    teamName: "Everton",
    teamShort: "EVE",
    positionId: 2,
    position: "Defender",
    positionShort: "DEF",
    price: 6.1,
    epNext: 8,
    form: 8,
    pointsPerGame: 6,
    priorExpectedGoals: 8,
    priorExpectedAssists: 5,
  });
  const data = dataFor([...initial, tarkowski]);
  const bank = 1.9;
  // Manager picks omit sellingPrice (public FPL shape) — finance must still derive conservatively.
  const manager = {
    bank,
    picks: initial.map((player, index) => ({
      elementId: player.id,
      position: index + 1,
      multiplier: index < 11 ? 1 : 0,
      isCaptain: index === 0,
      isViceCaptain: index === 1,
      sellingPrice: null,
    })),
  };
  const finance = deriveSandboxFinancialContext(initial, data.rules.budget, manager as never);
  assert.equal(finance.baselineBank, 1.9);
  assert.equal(finance.baselineSellingPrices.get(risen.id), 4.1, "selling must be purchase + floor(rises/2), not now_cost");
  assert.ok(risen.price + bank + 0.001 >= tarkowski.price, "sanity: market+bank would falsely afford");
  assert.ok(finance.baselineSellingPrices.get(risen.id)! + bank + 0.001 < tarkowski.price, "true selling+bank must not afford");
  const gate = isPlaceableTransfer(data, initial, risen, tarkowski, finance.baselineBank, finance.baselineSellingPrices);
  assert.equal(gate.placeable, false);
  if (!gate.placeable) assert.equal(gate.reason, "budget");
  const rows = bestTransfers(data, initial, finance.baselineBank, 1, 80, finance.baselineSellingPrices);
  assert.ok(
    !rows.some(row => row.out.id === risen.id && row.incoming.id === tarkowski.id),
    "risen-player market fallacy must not appear as ACTIONABLE / ranked",
  );
});

test("regression: empty selling map still rejects risen seller via conservative fallback", () => {
  const initial = squad();
  const out = initial.find(p => p.positionShort === "MID")!;
  out.price = 6.2;
  out.priceChangeSinceStart = 0.2; // purchase 6.0 → sell 6.1
  const expensive = makePlayer({
    id: 77,
    name: "Expensive",
    teamId: 77,
    teamName: "X FC",
    teamShort: "XFC",
    positionId: 3,
    position: "Midfielder",
    positionShort: "MID",
    price: 7.2,
    epNext: 10,
  });
  const data = dataFor([...initial, expensive]);
  const bank = 1.0; // market 6.2+1.0=7.2 fits; true sell 6.1+1.0=7.1 fails
  const gate = isPlaceableTransfer(data, initial, out, expensive, bank, new Map());
  assert.equal(gate.placeable, false);
  if (!gate.placeable) assert.equal(gate.reason, "budget");
});

test("regression: live bank £0.8 rejects Thomas/Maguire→Tarkowski and O'Nien→Guéhi that stale £2.1 would allow", () => {
  // Mohamed 261593: public entry_history.bank=2.1 but live my-team transfers.bank=0.8 after
  // pending Maguire/Barnes → Tarkowski/Tavernier. Ranking must use the live bank.
  const initial = squad();
  const thomas = makePlayer({
    id: 173, name: "Thomas", teamId: 7, teamName: "Coventry", teamShort: "COV",
    positionId: 2, position: "Defender", positionShort: "DEF", price: 4.0, epNext: 2,
  });
  const maguire = makePlayer({
    id: 418, name: "Maguire", teamId: 16, teamName: "Man Utd", teamShort: "MUN",
    positionId: 2, position: "Defender", positionShort: "DEF", price: 4.9, epNext: 2,
  });
  const onien = makePlayer({
    id: 539, name: "O'Nien", teamId: 20, teamName: "Sunderland", teamShort: "SUN",
    positionId: 2, position: "Defender", positionShort: "DEF", price: 3.9, epNext: 1,
  });
  // Replace three DEF slots
  const defIdx = initial.map((p, i) => (p.positionShort === "DEF" ? i : -1)).filter((i) => i >= 0);
  initial[defIdx[0]] = thomas;
  initial[defIdx[1]] = maguire;
  initial[defIdx[2]] = onien;

  const tarkowski = makePlayer({
    id: 229, name: "Tarkowski", teamId: 9, teamName: "Everton", teamShort: "EVE",
    positionId: 2, position: "Defender", positionShort: "DEF",
    price: 6.1, epNext: 8, form: 8, pointsPerGame: 6, priorExpectedGoals: 8, priorExpectedAssists: 5,
  });
  const guehi = makePlayer({
    id: 388, name: "Guéhi", teamId: 15, teamName: "Man City", teamShort: "MCI",
    positionId: 2, position: "Defender", positionShort: "DEF",
    price: 6.0, epNext: 7, form: 7, pointsPerGame: 5, priorExpectedGoals: 5, priorExpectedAssists: 4,
  });
  const data = dataFor([...initial, tarkowski, guehi]);

  const staleBank = 2.1;
  const liveBank = 0.8;
  const selling = new Map([
    [thomas.id, 4.0],
    [maguire.id, 4.9],
    [onien.id, 3.9],
  ]);

  // Sanity: stale bank would falsely afford Thomas→Tarkowski (4.0+2.1=6.1)
  assert.equal(isPlaceableTransfer(data, initial, thomas, tarkowski, staleBank, selling).placeable, true);
  // Live bank must reject all three Mohamed-flagged routes
  for (const [out, incoming, label] of [
    [thomas, tarkowski, "Thomas→Tarkowski"],
    [maguire, tarkowski, "Maguire→Tarkowski"],
    [onien, guehi, "O'Nien→Guéhi"],
  ] as const) {
    const gate = isPlaceableTransfer(data, initial, out, incoming, liveBank, selling);
    assert.equal(gate.placeable, false, `${label} must be rejected at live bank £0.8`);
    if (!gate.placeable) assert.equal(gate.reason, "budget");
  }

  const manager = {
    bank: liveBank,
    bankSource: "live-my-team" as const,
    picks: initial.map((player, index) => ({
      elementId: player.id,
      position: index + 1,
      multiplier: index < 11 ? 1 : 0,
      isCaptain: index === 0,
      isViceCaptain: index === 1,
      sellingPrice: selling.get(player.id) ?? player.price,
    })),
  };
  const finance = deriveSandboxFinancialContext(initial, data.rules.budget, manager as never);
  assert.equal(finance.baselineBank, 0.8);
  const rows = bestTransfers(data, initial, finance.baselineBank, 1, 80, finance.baselineSellingPrices);
  assert.ok(!rows.some((row) => row.out.id === thomas.id && row.incoming.id === tarkowski.id));
  assert.ok(!rows.some((row) => row.out.id === maguire.id && row.incoming.id === tarkowski.id));
  assert.ok(!rows.some((row) => row.out.id === onien.id && row.incoming.id === guehi.id));
});

test("regression: live bank £0.8 + pending Tarkowski owned drops O'Nien→Tarkowski and Palmer→B.Fernandes", () => {
  // Live my-team for 261593 after Maguire/Barnes → Tarkowski/Tavernier: Tarkowski already owned,
  // ITB £0.8. Stale cache still had Maguire+Barnes and £2.1, so Actionable ranked impossible rows.
  const initial = squad();
  const onien = makePlayer({
    id: 539, name: "O'Nien", teamId: 20, teamName: "Sunderland", teamShort: "SUN",
    positionId: 2, position: "Defender", positionShort: "DEF", price: 3.9, epNext: 1,
  });
  const tarkowski = makePlayer({
    id: 229, name: "Tarkowski", teamId: 9, teamName: "Everton", teamShort: "EVE",
    positionId: 2, position: "Defender", positionShort: "DEF",
    price: 6.1, epNext: 8, form: 8, pointsPerGame: 6, priorExpectedGoals: 8, priorExpectedAssists: 5,
  });
  const thomas = makePlayer({
    id: 173, name: "Thomas", teamId: 7, teamName: "Coventry", teamShort: "COV",
    positionId: 2, position: "Defender", positionShort: "DEF", price: 4.0, epNext: 2,
  });
  const defIdx = initial.map((p, i) => (p.positionShort === "DEF" ? i : -1)).filter((i) => i >= 0);
  initial[defIdx[0]] = onien;
  initial[defIdx[1]] = tarkowski; // pending live squad already owns Tarkowski
  initial[defIdx[2]] = thomas;

  const palmer = makePlayer({
    id: 154, name: "Palmer", teamId: 8, teamName: "Chelsea", teamShort: "CHE",
    positionId: 3, position: "Midfielder", positionShort: "MID",
    price: 9.7, epNext: 6, form: 6, pointsPerGame: 5,
  });
  const midIdx = initial.findIndex((p) => p.positionShort === "MID");
  initial[midIdx] = palmer;

  const fernandes = makePlayer({
    id: 426, name: "B.Fernandes", teamId: 16, teamName: "Man Utd", teamShort: "MUN",
    positionId: 3, position: "Midfielder", positionShort: "MID",
    price: 12.0, epNext: 10, form: 9, pointsPerGame: 8, priorExpectedGoals: 12, priorExpectedAssists: 15,
  });
  // Extra Tarkowski target for the owned-gate (same id already in squad — candidates come from data.players)
  const data = dataFor([...initial, fernandes]);

  const liveBank = 0.8;
  const selling = new Map(initial.map((player) => [player.id, player.price] as [number, number]));
  selling.set(onien.id, 3.9);
  selling.set(palmer.id, 9.7);

  assert.equal(
    isPlaceableTransfer(data, initial, onien, tarkowski, liveBank, selling).placeable,
    false,
    "O'Nien→Tarkowski must be owned-rejected when Tarkowski is already in the live squad",
  );
  const fernandesGate = isPlaceableTransfer(data, initial, palmer, fernandes, liveBank, selling);
  assert.equal(fernandesGate.placeable, false, "Palmer→B.Fernandes must be budget-rejected at £0.8 ITB");
  if (!fernandesGate.placeable) assert.equal(fernandesGate.reason, "budget");

  const manager = {
    bank: liveBank,
    bankSource: "live-my-team" as const,
    picks: initial.map((player, index) => ({
      elementId: player.id,
      position: index + 1,
      multiplier: index < 11 ? 1 : 0,
      isCaptain: index === 0,
      isViceCaptain: index === 1,
      sellingPrice: selling.get(player.id) ?? player.price,
    })),
  };
  const finance = deriveSandboxFinancialContext(initial, data.rules.budget, manager as never);
  assert.equal(finance.baselineBank, 0.8);
  const rows = bestTransfers(data, initial, finance.baselineBank, 1, 80, finance.baselineSellingPrices);
  assert.ok(
    !rows.some((row) => row.out.id === onien.id && row.incoming.id === tarkowski.id),
    "O'Nien→Tarkowski must be absent from ranked Actionable with live pending squad",
  );
  assert.ok(
    !rows.some((row) => row.out.id === palmer.id && row.incoming.id === fernandes.id),
    "Palmer→B.Fernandes must be absent from ranked Actionable at live bank £0.8",
  );
});
