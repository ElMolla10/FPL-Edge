import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    priorDefensiveContribution: 100, totalPoints: 0, eventPoints: 0, eventMinutes: 0, eventBonus: 0, eventDefensiveContribution: 0, selectedBy: 10, priceChange: 0, priceProjectionToday: 0, priceChangeSinceStart: 0, priceOutlook: [],
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

test("pitch cards never render the Apply bar, at any width, and still show name, price and xPts", () => {
  const player = makePlayer({ id: 21, name: "Bruno", teamShort: "MUN", price: 8.5 });
  const props = {
    player,
    projectedPoints: "5.4",
    complete: true,
    selected: false,
    swapTarget: false,
    showPin: false,
    pinned: false,
    onSelect: () => {},
    onTogglePin: () => {},
    onRemove: () => {},
    showChipButton: true,
    onApplyChip: () => {},
  };
  const idle = renderToStaticMarkup(createElement(liveDraftBuilder.BuilderPitchPlayerCard, { ...props, chipApplied: false }));
  assert.doesNotMatch(idle, /apply-chip-button|Apply TC|Apply Triple Captain/, "the on-card Apply control is gone even when showChipButton is set");
  assert.match(idle, /<b>Bruno<\/b>/);
  assert.match(idle, /MUN · £8\.5m/);
  assert.match(idle, />5\.4 xPts</);
  assert.match(idle, /class="remove-player" aria-label="Remove Bruno"/);
  assert.match(idle, /<\/button><\/article>$/);

  const applied = renderToStaticMarkup(createElement(liveDraftBuilder.BuilderPitchPlayerCard, { ...props, chipApplied: true }));
  assert.doesNotMatch(applied, /apply-chip-button|Apply TC/);
  assert.match(applied, /<em class="tc-mark" aria-label="Triple Captain">TC<\/em><\/article>$/);
  assert.match(applied, />5\.4 xPts</);
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

test("chosen Triple Captain is a small in-card mark, not a bar after the apply button or a replacement for xPts", () => {
  const player = makePlayer({ id: 21, name: "Bruno" });
  const marked = renderToStaticMarkup(createElement(liveDraftBuilder.BuilderPitchPlayerCard, {
    player,
    projectedPoints: "5.4",
    complete: true,
    selected: false,
    swapTarget: false,
    showPin: false,
    pinned: false,
    onSelect: () => {},
    onTogglePin: () => {},
    onRemove: () => {},
    showChipButton: false,
    chipApplied: true,
  }));
  assert.match(marked, /<b>Bruno<\/b>/);
  assert.match(marked, />5\.4 xPts</);
  assert.match(marked, /<em class="tc-mark" aria-label="Triple Captain">TC<\/em>/);
  assert.doesNotMatch(marked, /apply-chip-button/, "bench cards keep the mark without bringing the apply button back");
  assert.match(marked, /<em class="tc-mark" aria-label="Triple Captain">TC<\/em><\/article>$/, "the mark is a small badge on the card, not a second button");

  const appliedWithButton = renderToStaticMarkup(createElement(liveDraftBuilder.BuilderPitchPlayerCard, {
    player,
    projectedPoints: "5.4",
    complete: true,
    selected: false,
    swapTarget: false,
    showPin: false,
    pinned: false,
    onSelect: () => {},
    onTogglePin: () => {},
    onRemove: () => {},
    showChipButton: true,
    chipApplied: true,
    onApplyChip: () => {},
  }));
  assert.doesNotMatch(appliedWithButton, /apply-chip-button|Apply TC/, "the TC mark does not bring the Apply bar back");
  assert.match(appliedWithButton, /<em class="tc-mark" aria-label="Triple Captain">TC<\/em><\/article>$/);
});

test("Triple Captain chip card is labelled Triple Captain and Plan Triple Captain, then Cancel while armed", () => {
  const idle = renderToStaticMarkup(createElement(liveDraftBuilder.TripleCaptainAction, {
    plannedEvent: null, armedWeek: null, onPlan: () => {}, onCancel: () => {}, onRemove: () => {},
  }));
  assert.match(idle, /<b>Triple Captain<\/b>/);
  assert.match(idle, />Plan Triple Captain</);
  assert.doesNotMatch(idle, />TC</);
  assert.doesNotMatch(idle, /3xc/);

  const armed = renderToStaticMarkup(createElement(liveDraftBuilder.TripleCaptainAction, {
    plannedEvent: null, armedWeek: 12, onPlan: () => {}, onCancel: () => {}, onRemove: () => {},
  }));
  assert.match(armed, />Cancel</);
  assert.match(armed, /Tap an owned player on the pitch for GW12/);
  assert.doesNotMatch(armed, />Plan Triple Captain</);

  const planned = renderToStaticMarkup(createElement(liveDraftBuilder.TripleCaptainAction, {
    plannedEvent: 12, armedWeek: null, onPlan: () => {}, onCancel: () => {}, onRemove: () => {},
  }));
  assert.match(planned, /Planned for GW12/);
  assert.match(planned, />Remove Triple Captain plan</);
});

test("arming Triple Captain steals pitch clicks only until pick or cancel", () => {
  assert.equal(liveDraftBuilder.pitchClickIntent(false, true), "swap");
  assert.equal(liveDraftBuilder.pitchClickIntent(true, true), "triple-captain");
  assert.equal(liveDraftBuilder.pitchClickIntent(true, false), "triple-captain");
  let armed = liveDraftBuilder.nextTripleCaptainArm(null, "arm", 8);
  assert.equal(armed, 8);
  assert.equal(liveDraftBuilder.pitchClickIntent(armed != null, true), "triple-captain");
  armed = liveDraftBuilder.nextTripleCaptainArm(armed, "failed", null);
  assert.equal(armed, 8, "a rejected apply keeps the arm so cancel is still available");
  armed = liveDraftBuilder.nextTripleCaptainArm(armed, "picked", null);
  assert.equal(armed, null);
  assert.equal(liveDraftBuilder.pitchClickIntent(armed != null, true), "swap", "after a player is chosen, transfer clicks work again");
  armed = liveDraftBuilder.nextTripleCaptainArm(liveDraftBuilder.nextTripleCaptainArm(null, "arm", 4), "cancel", null);
  assert.equal(armed, null);
  assert.equal(liveDraftBuilder.pitchClickIntent(armed != null, true), "swap", "after cancel, transfer clicks work again");
});

test("Save as plan keeps Triple Captain on the existing plan chip slot, unless Wildcard or Free Hit is explicit", () => {
  const loaded = { chip: "Wildcard" as const, event: 3 };
  assert.deepEqual(
    liveDraftBuilder.planChipTagForSave(loaded, null, [{ event: 9, chip: "Triple Captain" }]),
    { chip: "Triple Captain", event: 9 },
  );
  assert.deepEqual(
    liveDraftBuilder.planChipTagForSave(loaded, { chip: "Free Hit", event: 6 }, [{ event: 9, chip: "Triple Captain" }]),
    { chip: "Free Hit", event: 6 },
  );
  assert.deepEqual(
    liveDraftBuilder.planChipTagForSave(loaded, null, [{ event: 2, chip: "Bench Boost" }]),
    loaded,
  );
  assert.equal(liveDraftBuilder.planChipTagForSave(undefined, null, []), undefined);
});

test("Triple Captain sits under Bench Boost and pitch clicks go through the arm, without a phone apply bar", () => {
  const source = readFileSync(new URL("../app/components/LiveDraftBuilder.tsx", import.meta.url), "utf8");
  const row = source.slice(source.indexOf('className="chip-actions-row"'));
  const boost = row.indexOf("chip-action-bench-boost");
  const triple = row.indexOf("<TripleCaptainAction");
  const wild = row.indexOf("chip-action-wildcard");
  assert.ok(boost >= 0 && triple > boost && wild > triple, "Triple Captain is directly under Bench Boost, before Wildcard / Free Hit");
  assert.match(source, /onSelect=\{\(\)=>onPitchPlayer\(player\)\}/);
  assert.match(source, /pitchClickIntent\(tcArmedWeek!=null,complete\)/);
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const phone = css.slice(css.lastIndexOf("@media(max-width:850px)"));
  assert.match(phone, /\.builder-pitch-row article \.apply-chip-button\{display:none\}/);
  assert.match(css, /\.builder-pitch-row article \.apply-chip-button\{display:none\}/);
  assert.match(css, /\.coach-pitch-player \.apply-chip-button\{display:none\}/);
  assert.doesNotMatch(css, /\.builder-pitch-row article \.apply-chip-button\{[^}]*background/);
  assert.match(phone, /\.builder-pitch-row article \.remove-player\{top:1px;right:1px/);
  assert.match(phone, /\.builder-pitch-row article \.tc-mark\{left:1px;top:1px/);
  assert.doesNotMatch(phone, /\.tc-mark\{[^}]*position:fixed/);
});
