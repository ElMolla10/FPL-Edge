import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_HIT_POLICY, parseHitPolicy } from "../app/lib/fpl-bot/config.ts";
import type { PicksPayload, TransfersPayload } from "../app/lib/fpl-bot/payloads.ts";
import type { BotMyTeam, BotMyTeamChip } from "../app/lib/fpl-bot/types.ts";
import { chipAvailable, elementsFromBootstrap, validatePicksPayload, validateSquadIds, validateTransfersPayload, type ElementInfo } from "../app/lib/fpl-bot/validate.ts";

// Synthetic world: 20 clubs; ids 1-2 GK, 3-7 DEF, 8-12 MID, 13-15 FWD (the squad), 100+ = transfer targets.
const elements = new Map<number, ElementInfo>();
const add = (id: number, positionId: number, teamId: number, nowCost = 50, status = "a", chance: number | null = null) => elements.set(id, { id, positionId, teamId, status, chance, nowCost });
const POS = [1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4];
POS.forEach((p, i) => add(i + 1, p, i + 1)); // every squad player from a different club
add(101, 2, 16, 55); // DEF target
add(102, 3, 17, 60); // MID target
add(103, 4, 18, 45); // FWD target
add(104, 2, 1, 50, "i", 0); // injured DEF
add(105, 2, 2, 50); // DEF from club 2
add(106, 2, 2, 50); // DEF from club 2
add(107, 2, 2, 50); // DEF from club 2
const SQUAD = POS.map((_, i) => i + 1);
const ENTRY = "4242";
const NOW = Date.parse("2026-10-10T08:00:00Z");
const DEADLINE = NOW + 2 * 3_600_000;

const chip = (name: BotMyTeamChip["name"], extra: Partial<BotMyTeamChip> = {}): BotMyTeamChip => ({ name, status_for_entry: "available", played_by_entry: [], start_event: 1, stop_event: 19, is_pending: false, ...extra } as BotMyTeamChip);

function team(overrides: Partial<BotMyTeam> = {}): BotMyTeam {
  return {
    picks: SQUAD.map((element, i) => ({ element, position: i + 1, multiplier: i < 11 ? (i === 10 ? 2 : 1) : 0, is_captain: i === 10, is_vice_captain: i === 9, selling_price: 50, purchase_price: 50 })),
    transfers: { bank: 10, limit: 1, made: 0, cost: 0 },
    chips: [chip("wildcard"), chip("freehit"), chip("bboost"), chip("3xc")],
    ...overrides,
  } as BotMyTeam;
}
const ctx = (over: Partial<Parameters<typeof validateTransfersPayload>[1]> = {}) => ({
  botEntry: ENTRY, event: 8, nowMs: NOW, deadlineMs: DEADLINE, deadlineGuardMs: 300_000, myTeam: team(), elements, freeTransfers: 1, hitPolicy: DEFAULT_HIT_POLICY, recentHitPoints: 0, ...over,
});
const tp = (legs: Array<[number, number, number?, number?]>, over: Partial<TransfersPayload> = {}): TransfersPayload => ({
  entry: Number(ENTRY), event: 8, chip: null, confirmed: true,
  transfers: legs.map(([out, inn, sell = 50, buy]) => ({ element_out: out, element_in: inn, selling_price: sell, purchase_price: buy ?? elements.get(inn)?.nowCost ?? 0 })),
  ...over,
} as TransfersPayload);

test("validateSquadIds: a legal 15 passes; size, duplicates, positions and the 3-per-club rule fail", () => {
  assert.deepEqual(validateSquadIds(SQUAD, elements), []);
  assert.ok(validateSquadIds(SQUAD.slice(0, 14), elements).some((e) => e.includes("15 players")));
  assert.ok(validateSquadIds([...SQUAD.slice(0, 14), 1], elements).some((e) => e.includes("duplicate")));
  assert.ok(validateSquadIds([...SQUAD.slice(0, 14), 101], elements).some((e) => e.includes("position")));
  // replace DEF 3,4,5 with 105-107 (club 2) while GK 2 is also club 2 => 4 from club 2
  const tooMany = SQUAD.map((id) => (id === 3 ? 105 : id === 4 ? 106 : id === 5 ? 107 : id));
  assert.ok(validateSquadIds(tooMany, elements).some((e) => e.includes("more than 3")));
  assert.ok(validateSquadIds([...SQUAD.slice(0, 14), 999], elements).some((e) => e.includes("unknown")));
});

test("transfers: one free transfer like-for-like within budget is valid and costs 0", () => {
  const v = validateTransfersPayload(tp([[3, 101]]), ctx());
  assert.deepEqual(v.errors, []);
  assert.equal(v.hitCost, 0);
  assert.equal(v.bankAfter, 10 + 50 - 55);
  assert.ok(v.finalSquad.includes(101) && !v.finalSquad.includes(3));
});

test("transfers: wrong entry, wrong event, unconfirmed, past the deadline guard are all rejected", () => {
  assert.ok(validateTransfersPayload(tp([[3, 101]], { entry: 261 }), ctx()).errors.some((e) => e.includes("not the bot entry")));
  assert.ok(validateTransfersPayload(tp([[3, 101]], { event: 9 }), ctx()).errors.some((e) => e.includes("event")));
  assert.ok(validateTransfersPayload(tp([[3, 101]], { confirmed: false } as unknown as Partial<TransfersPayload>), ctx()).errors.some((e) => e.includes("confirmed")));
  assert.ok(validateTransfersPayload(tp([[3, 101]]), ctx({ nowMs: DEADLINE - 60_000 })).errors.some((e) => e.includes("deadline")));
});

test("transfers: position change, unknown / injured / already-owned targets, stale prices and overspend are rejected", () => {
  assert.ok(validateTransfersPayload(tp([[3, 102]]), ctx()).errors.some((e) => e.includes("changes position")));
  assert.ok(validateTransfersPayload(tp([[3, 999, 50, 50]]), ctx()).errors.some((e) => e.includes("unknown")));
  assert.ok(validateTransfersPayload(tp([[3, 104]]), ctx()).errors.some((e) => e.includes("0% chance")));
  assert.ok(validateTransfersPayload(tp([[3, 4, 50, 50]]), ctx()).errors.some((e) => e.includes("already in the squad")));
  assert.ok(validateTransfersPayload(tp([[3, 101, 50, 54]]), ctx()).errors.some((e) => e.includes("stale")));
  assert.ok(validateTransfersPayload(tp([[3, 101, 49]]), ctx()).errors.some((e) => e.includes("selling price")));
  assert.ok(validateTransfersPayload(tp([[3, 101]]), ctx({ myTeam: team({ transfers: { bank: 0, limit: 1, made: 0 } }) })).errors.some((e) => e.includes("over budget")));
  assert.ok(validateTransfersPayload(tp([[99, 101]]), ctx()).errors.some((e) => e.includes("not in the squad")));
});

test("hits policy: default allows exactly one -4; a second hit, hits under 'none', and the rolling cap are refused", () => {
  const twoLegs = tp([[3, 101], [8, 102]]);
  const one = validateTransfersPayload(twoLegs, ctx({ myTeam: team({ transfers: { bank: 100, limit: 1, made: 0 } }) }));
  assert.deepEqual(one.errors, []);
  assert.equal(one.hitCost, 4);
  const three = tp([[3, 101], [8, 102], [13, 103]]);
  assert.ok(validateTransfersPayload(three, ctx({ myTeam: team({ transfers: { bank: 100, limit: 1, made: 0 } }) })).errors.some((e) => e.includes("too many transfers") || e.includes("hit policy")));
  assert.ok(validateTransfersPayload(twoLegs, ctx({ hitPolicy: parseHitPolicy("none"), myTeam: team({ transfers: { bank: 100, limit: 1, made: 0 } }) })).errors.length > 0);
  assert.ok(validateTransfersPayload(twoLegs, ctx({ recentHitPoints: 8, myTeam: team({ transfers: { bank: 100, limit: 1, made: 0 } }) })).errors.some((e) => e.includes("rolling")));
  assert.equal(parseHitPolicy(undefined).maxHitsPerGw, 1);
  assert.equal(parseHitPolicy("max2").maxHitsPerGw, 2);
  assert.equal(parseHitPolicy("garbage").maxHitsPerGw, 1);
});

test("chips on transfers: WC/FH must be available, one chip per GW, FH never in GW1, unknown free transfers refuse", () => {
  const wc = tp([[3, 101], [8, 102], [13, 103]], { chip: "wildcard" });
  const ok = validateTransfersPayload(wc, ctx({ myTeam: team({ transfers: { bank: 100, limit: 1, made: 0 } }) }));
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.hitCost, 0, "wildcard transfers are free");
  const used = team({ transfers: { bank: 100, limit: 1, made: 0 }, chips: [chip("wildcard", { status_for_entry: "played" } as Partial<BotMyTeamChip>)] });
  assert.ok(validateTransfersPayload(wc, ctx({ myTeam: used })).errors.some((e) => e.includes("not available")));
  const bbPending = team({ transfers: { bank: 100, limit: 1, made: 0 }, chips: [chip("wildcard"), chip("bboost", { is_pending: true })] });
  assert.ok(validateTransfersPayload(wc, ctx({ myTeam: bbPending })).errors.some((e) => e.includes("already active")));
  const fh1 = tp([[3, 101]], { chip: "freehit", event: 1 });
  assert.ok(validateTransfersPayload(fh1, ctx({ event: 1 })).errors.some((e) => e.includes("GW1")));
  assert.ok(validateTransfersPayload(tp([[3, 101]], { chip: "bboost" as never }), ctx()).errors.some((e) => e.includes("not a transfer chip")));
  assert.ok(validateTransfersPayload(tp([[3, 101]]), ctx({ freeTransfers: null })).errors.some((e) => e.includes("free transfers unknown")));
  assert.equal(chipAvailable([chip("3xc", { start_event: 20, stop_event: 38 })], "3xc", 8), false, "second-half chip not usable in the first half");
});

// ---- picks -------------------------------------------------------------------------------------------------
const picks = (order: number[] = SQUAD, captain = 11, vice = 10, chipName: PicksPayload["chip"] = null): PicksPayload => ({
  chip: chipName,
  picks: order.map((element, i) => ({ element, position: i + 1, is_captain: element === captain, is_vice_captain: element === vice })),
});
// a legal XI ordering: GK1, DEF 3-7, MID 8-11 (4), FWD 13 ... bench GK2 first
const LEGAL = [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 2, 12, 14, 15];
const pctx = (over: Partial<Parameters<typeof validatePicksPayload>[1]> = {}) => ({ squadIds: SQUAD, elements, myTeam: team(), event: 8, nowMs: NOW, deadlineMs: DEADLINE, deadlineGuardMs: 300_000, transferChipThisGw: false, ...over });

test("picks: a legal 5-4-1 with captain/vice in the XI passes", () => {
  assert.deepEqual(validatePicksPayload(picks(LEGAL, 13, 11), pctx()), []);
});

test("picks: formation, GK slots, missing/duplicate players, captain rules and flagged captains fail", () => {
  // 2 GKs in the XI
  const twoGk = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 11, 12, 14, 15];
  assert.ok(validatePicksPayload(picks(twoGk, 13, 11), pctx()).some((e) => e.includes("GK")));
  // no FWD in the XI
  const noFwd = [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 2, 13, 14, 15];
  assert.ok(validatePicksPayload(picks(noFwd, 11, 10), pctx()).some((e) => e.includes("FWD")));
  // captain on the bench
  assert.ok(validatePicksPayload(picks(LEGAL, 14, 11), pctx()).some((e) => e.includes("captain must be in the starting XI")));
  assert.ok(validatePicksPayload(picks(LEGAL, 13, 13), pctx()).some((e) => e.includes("differ")));
  assert.ok(validatePicksPayload(picks(LEGAL.slice(0, 14)), pctx()).some((e) => e.includes("exactly 15")));
  assert.ok(validatePicksPayload(picks([...LEGAL.slice(0, 14), 101], 13, 11), pctx()).some((e) => e.includes("current squad")));
  const flagged = new Map(elements);
  flagged.set(13, { ...elements.get(13)!, status: "i", chance: 0 });
  assert.ok(validatePicksPayload(picks(LEGAL, 13, 11), pctx({ elements: flagged })).some((e) => e.includes("flagged out")));
  assert.ok(validatePicksPayload(picks(LEGAL, 13, 11), pctx({ nowMs: DEADLINE })).some((e) => e.includes("deadline")));
});

test("picks chips: BB/TC must be available and never stack with a WC/FH or another chip", () => {
  assert.deepEqual(validatePicksPayload(picks(LEGAL, 13, 11, "bboost"), pctx()), []);
  assert.ok(validatePicksPayload(picks(LEGAL, 13, 11, "3xc"), pctx({ transferChipThisGw: true })).some((e) => e.includes("one chip")));
  assert.ok(validatePicksPayload(picks(LEGAL, 13, 11, "3xc"), pctx({ myTeam: team({ chips: [chip("3xc"), chip("bboost", { is_pending: true })] }) })).some((e) => e.includes("already active")));
  assert.ok(validatePicksPayload(picks(LEGAL, 13, 11, "3xc"), pctx({ myTeam: team({ chips: [chip("3xc", { status_for_entry: "played" } as Partial<BotMyTeamChip>)] }) })).some((e) => e.includes("not available")));
  assert.ok(validatePicksPayload(picks(LEGAL, 13, 11, "wildcard" as never), pctx()).some((e) => e.includes("not a team chip")));
  // re-saving with the chip that is already pending is fine (idempotent lineup re-save)
  assert.deepEqual(validatePicksPayload(picks(LEGAL, 13, 11, "bboost"), pctx({ myTeam: team({ chips: [chip("bboost", { is_pending: true, status_for_entry: "active" } as Partial<BotMyTeamChip>)] }) })), []);
});

test("elementsFromBootstrap maps the official shape and ignores junk", () => {
  const map = elementsFromBootstrap({ elements: [{ id: 7, element_type: 3, team: 4, status: "d", chance_of_playing_next_round: 75, now_cost: 81 }, { id: "x" }] });
  assert.equal(map.size, 1);
  assert.deepEqual(map.get(7), { id: 7, positionId: 3, teamId: 4, status: "d", chance: 75, nowCost: 81 });
  assert.equal(elementsFromBootstrap(null).size, 0);
});
