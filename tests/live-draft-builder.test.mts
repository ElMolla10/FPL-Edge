import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as liveDraftBuilder from "../app/components/LiveDraftBuilder.tsx";
import { resolveResultModeDispatch, validateSwap } from "../app/components/LiveDraftBuilder.tsx";
import { FplPlayer } from "../app/lib/fpl.ts";

function makePlayer(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1, name: "Test", firstName: "Test", secondName: "Player", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: 3, position: "Midfielder", positionShort: "MID", price: 6, status: "a", chance: null,
    epNext: 2, form: 2, pointsPerGame: 3, priorPointsPerGame: 3, priorMinutes: 2500, priorStarts: 30,
    priorExpectedGoals: 3, priorExpectedAssists: 3, priorBonus: 10, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 100, totalPoints: 0, eventPoints: 0, eventMinutes: 0, eventBonus: 0, eventDefensiveContribution: 0, selectedBy: 10, priceChange: 0, priceProjectionToday: 0,
    transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0,
    expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 0,
    starts: 0, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0,
    penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
    ...overrides,
  };
}

// A bland, uniform 15-player squad so each validateSwap test only has to describe its own specific
// deviation, not fight unrelated variation elsewhere -- same construction pattern already used in
// tests/optimizer-constrained.test.mts. Prices and clubs are deliberately spread out (see per-test
// overrides) rather than uniform, since club-limit and budget are exactly what's under test here.
function baseSquad(): FplPlayer[] {
  const gkps = [1, 2].map(n => makePlayer({ id: n, positionShort: "GKP", positionId: 1, position: "Goalkeeper", price: 4.5, teamId: 100 + n, teamName: `Club${100 + n}` }));
  const defs = [11, 12, 13, 14, 15].map(n => makePlayer({ id: n, positionShort: "DEF", positionId: 2, position: "Defender", price: 5, teamId: 200 + n, teamName: `Club${200 + n}` }));
  const mids = [21, 22, 23, 24, 25].map(n => makePlayer({ id: n, positionShort: "MID", positionId: 3, position: "Midfielder", price: 6, teamId: 300 + n, teamName: `Club${300 + n}` }));
  const fwds = [31, 32, 33].map(n => makePlayer({ id: n, positionShort: "FWD", positionId: 4, position: "Forward", price: 6, teamId: 400 + n, teamName: `Club${400 + n}` }));
  return [...gkps, ...defs, ...mids, ...fwds];
}
const rules = { budget: 100, teamLimit: 3 };

test("occupied pitch card renders transfer selection, pin and remove as sibling keyboard buttons", () => {
  assert.equal(typeof liveDraftBuilder.BuilderPitchPlayerCard, "function", "occupied player-card markup must be directly testable");
  const player = makePlayer({ id: 21, name: "Bruno" });
  const html = renderToStaticMarkup(createElement(liveDraftBuilder.BuilderPitchPlayerCard, {
    player,
    projectedPoints: "5.4",
    complete: true,
    selected: false,
    swapTarget: false,
    showPin: true,
    pinned: false,
    onSelect: () => {},
    onTogglePin: () => {},
    onRemove: () => {},
  }));

  assert.match(html, /<article[^>]*><button type="button" class="player-transfer-select" aria-label="Select Bruno for transfer"/);
  assert.match(html, /<\/button><button type="button" class="pin-toggle/);
  assert.match(html, /<\/button><button type="button" class="remove-player" aria-label="Remove Bruno"/);
});

test("validateSwap rejects a wrong-position incoming player, even though the UI's own position filter would normally have prevented this", () => {
  const squad = baseSquad();
  const outPlayer = squad.find(p => p.id === 21)!; // MID
  const incoming = makePlayer({ id: 999, name: "WrongPos", positionShort: "DEF", positionId: 2, teamId: 999, teamName: "Other FC", price: 5 });
  const result = validateSwap(squad, outPlayer, incoming, rules);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.match(result.message, /different position/);
});

test("validateSwap rejects a player already in the squad", () => {
  const squad = baseSquad();
  const outPlayer = squad.find(p => p.id === 21)!; // MID
  const incoming = squad.find(p => p.id === 22)!; // a different MID already owned
  const result = validateSwap(squad, outPlayer, incoming, rules);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.match(result.message, /already in your squad/);
});

test("validateSwap rejects an unavailable player even when position, club and budget are legal", () => {
  const squad = baseSquad();
  const outPlayer = squad.find(p => p.id === 21)!;
  const incoming = makePlayer({ id: 993, name: "Unavailable", status: "u", positionShort: "MID", positionId: 3, teamId: 999, teamName: "Other FC", price: 6 });
  const result = validateSwap(squad, outPlayer, incoming, rules);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.match(result.message, /unavailable/);
});

test("validateSwap rejects a club swap that would put the squad AT the club limit and allows one below it", () => {
  // Three DEF slots already belong to the same club (200), none of them the outgoing player.
  const atCapSquad = baseSquad().map(p => ([12, 13, 14].includes(p.id) ? { ...p, teamId: 200, teamName: "Club200" } : p));
  const outPlayer = atCapSquad.find(p => p.id === 21)!; // MID, unrelated club, so removal doesn't free a Club200 slot
  const atCap = makePlayer({ id: 998, name: "AtCap", positionShort: "MID", positionId: 3, teamId: 200, teamName: "Club200", price: 6 });
  const rejected = validateSwap(atCapSquad, outPlayer, atCap, rules);
  assert.equal(rejected.ok, false);
  if (rejected.ok) throw new Error("unreachable");
  assert.match(rejected.message, /Maximum 3 players/);

  // Same shape, but only two DEF slots belong to that club -- one below the cap, so the swap must
  // be allowed even though the incoming player shares that club.
  const belowCapSquad = baseSquad().map(p => ([12, 13].includes(p.id) ? { ...p, teamId: 200, teamName: "Club200" } : p));
  const outPlayer2 = belowCapSquad.find(p => p.id === 21)!;
  const belowCap = makePlayer({ id: 997, name: "BelowCap", positionShort: "MID", positionId: 3, teamId: 200, teamName: "Club200", price: 6 });
  const allowed = validateSwap(belowCapSquad, outPlayer2, belowCap, rules);
  assert.equal(allowed.ok, true);
});

test("validateSwap allows a same-club swap at the cap, since removing the outgoing player frees the slot the incoming player fills", () => {
  // This is the exact bug the swap() rewrite fixed: club limit must be checked against the squad
  // WITH the outgoing player already removed, not the full current squad.
  const squad = baseSquad().map(p => (p.id === 11 || p.id === 12 || p.id === 13 ? { ...p, teamId: 200, teamName: "Club200" } : p));
  const outPlayer = squad.find(p => p.id === 11)!; // one of the three Club200 players being replaced
  const incoming = makePlayer({ id: 996, name: "SameClub", positionShort: "DEF", positionId: 2, teamId: 200, teamName: "Club200", price: 5 });
  const result = validateSwap(squad, outPlayer, incoming, rules);
  assert.equal(result.ok, true);
});

test("validateSwap rejects a swap that exceeds budget by the smallest realistic margin (£0.1m) and allows landing exactly on budget", () => {
  // Squad totals exactly £100.0m (15 players: 2*4.5 + 5*5 + 5*6 + 3*6 = 9+25+30+18 = 82... adjust by
  // pricing the outgoing player precisely so total-minus-out plus incoming lands on a known figure.
  const squad = baseSquad();
  const totalCost = squad.reduce((s, p) => s + p.price, 0);
  const outPlayer = squad.find(p => p.id === 21)!; // price 6
  const remainingBudget = rules.budget - (totalCost - outPlayer.price);

  const exact = makePlayer({ id: 995, name: "ExactBudget", positionShort: "MID", positionId: 3, teamId: 999, teamName: "Other FC", price: remainingBudget });
  assert.equal(validateSwap(squad, outPlayer, exact, rules).ok, true);

  const overByOneStep = makePlayer({ id: 994, name: "OverBudget", positionShort: "MID", positionId: 3, teamId: 999, teamName: "Other FC", price: Number((remainingBudget + 0.1).toFixed(1)) });
  const rejected = validateSwap(squad, outPlayer, overByOneStep, rules);
  assert.equal(rejected.ok, false);
  if (rejected.ok) throw new Error("unreachable");
  assert.match(rejected.message, /exceeds the/);
});

test("official bank and selling prices allow an affordable transfer from an imported squad worth more than £100m", () => {
  const squad = baseSquad().map(player => ({ ...player, price: player.price + 2 }));
  const outPlayer = squad.find(player => player.id === 21)!;
  const incoming = makePlayer({ id: 992, name: "Affordable", positionShort: "MID", positionId: 3, teamId: 999, teamName: "Other FC", price: 8 });
  const financialContext = {
    baselineBank: 1,
    baselineSellingPrices: new Map(squad.map(player => [player.id, player.id === outPlayer.id ? 7 : player.price])),
    source: "official" as const,
  };

  const result = validateSwap(squad, outPlayer, incoming, rules, { baselineSquad: squad, financialContext });

  assert.equal(result.ok, true, "market value above £100m must not block a plan affordable from official sale value plus bank");
});

test("official selling price rejects a transfer that current market price would incorrectly afford", () => {
  const squad = baseSquad().map(player => player.id === 21 ? { ...player, price: 10 } : player);
  const outPlayer = squad.find(player => player.id === 21)!;
  const incoming = makePlayer({ id: 991, name: "TooExpensive", positionShort: "MID", positionId: 3, teamId: 999, teamName: "Other FC", price: 6.6 });
  const financialContext = {
    baselineBank: .5,
    baselineSellingPrices: new Map(squad.map(player => [player.id, player.id === outPlayer.id ? 6 : player.price])),
    source: "official" as const,
  };

  const result = validateSwap(squad, outPlayer, incoming, rules, { baselineSquad: squad, financialContext });

  assert.equal(result.ok, false, "£6.0m official sale plus £0.5m bank cannot buy a £6.6m player");
  if (result.ok) throw new Error("unreachable");
  assert.match(result.message, /bank|afford/i);
});

test("Pure Optimum dispatches to optimize(), ignoring any pinned players", () => {
  assert.deepEqual(resolveResultModeDispatch("Pure Optimum", new Set()), { kind: "optimize" });
  // Pins can be left over from a prior Keep Core session (pin state isn't cleared on mode switch,
  // by design -- see LiveDraftBuilder.tsx). Pure Optimum must still ignore them entirely.
  assert.deepEqual(resolveResultModeDispatch("Pure Optimum", new Set([1, 2, 3])), { kind: "optimize" });
});

test("Practical Upgrade dispatches to optimizeConstrained with maxChanges:3 and no locked players, even if pins exist", () => {
  const dispatch = resolveResultModeDispatch("Practical Upgrade", new Set([1, 2, 3]));
  assert.equal(dispatch.kind, "optimizeConstrained");
  if (dispatch.kind !== "optimizeConstrained") throw new Error("unreachable");
  assert.equal(dispatch.maxChanges, 3);
  // The whole point of this assertion: Practical Upgrade must never lock a player out of the search,
  // regardless of what's pinned from a Keep Core session -- pins are Keep Core-specific input, and
  // silently carrying them into Practical Upgrade would be a real correctness bug, not a cosmetic one.
  assert.equal(dispatch.lockedPlayerIds.size, 0);
});

test("Keep Core dispatches to optimizeConstrained with maxChanges:4 and exactly the passed pinned players", () => {
  const pins = new Set([7, 42]);
  const dispatch = resolveResultModeDispatch("Keep Core", pins);
  assert.equal(dispatch.kind, "optimizeConstrained");
  if (dispatch.kind !== "optimizeConstrained") throw new Error("unreachable");
  assert.equal(dispatch.maxChanges, 4);
  assert.deepEqual(dispatch.lockedPlayerIds, pins);
});

test("Keep Core with no pins yet still dispatches to optimizeConstrained (not Pure Optimum), with an empty locked set", () => {
  const dispatch = resolveResultModeDispatch("Keep Core", new Set());
  assert.equal(dispatch.kind, "optimizeConstrained");
  if (dispatch.kind !== "optimizeConstrained") throw new Error("unreachable");
  assert.equal(dispatch.maxChanges, 4);
  assert.equal(dispatch.lockedPlayerIds.size, 0);
});
