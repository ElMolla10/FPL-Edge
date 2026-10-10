/**
 * P1 chip hotfix: expiry-aware chip reservation, consistent activation/cancellation for TC/BB, and the Bench Boost
 * bench-GK gate. Synthetic league (same shape as fpl-bot-planner.test.mts) with deadlines relative to the real clock,
 * so these tests do not age out. Pure: no network, no D1.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { FplData, FplPlayer } from "../app/lib/fpl.ts";
import { DEFAULT_HIT_POLICY } from "../app/lib/fpl-bot/config.ts";
import { buildPicksPayload } from "../app/lib/fpl-bot/payloads.ts";
import { CHIP_GUARDS, benchBoostExceptional, benchBoostGuardOk, buildLineup, wildcardExpiryValue, elementsFromData, expiryState, pickExpiryChip, planGameweek, rebuildSquad, type PlanInput } from "../app/lib/fpl-bot/planner.ts";
import type { BotMyTeam, BotMyTeamChip, OfficialChip } from "../app/lib/fpl-bot/types.ts";
import { validatePicksPayload, validateSquadIds } from "../app/lib/fpl-bot/validate.ts";

const POS = [[1, "GKP"], [2, "DEF"], [2, "DEF"], [3, "MID"], [3, "MID"], [4, "FWD"]] as const;
function player(id: number, teamId: number, positionId: number, positionShort: string, quality: number): FplPlayer {
  return {
    id, name: `P${id}`, firstName: "P", secondName: String(id), teamId, teamName: `Team ${teamId}`, teamShort: `T${teamId}`,
    positionId, position: positionShort, positionShort, price: Math.round((4 + quality * 0.8) * 10) / 10, status: "a", chance: null,
    epNext: 1 + quality * 0.6, form: 1 + quality * 0.5, pointsPerGame: 2 + quality * 0.5, priorPointsPerGame: 2 + quality * 0.5, priorMinutes: 2800, priorStarts: 32,
    priorExpectedGoals: positionId >= 3 ? quality : 0.5, priorExpectedAssists: positionId >= 2 ? quality / 2 : 0, priorBonus: quality * 2, priorSaves: positionId === 1 ? 90 : 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 100, totalPoints: 0, eventPoints: 0, eventMinutes: 0, eventBonus: 0, eventDefensiveContribution: 0, selectedBy: 5 + quality, priceChange: 0, priceProjectionToday: 0, priceChangeSinceStart: 0, priceOutlook: [],
    transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0,
    expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 0,
    starts: 0, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0,
    penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
  } as FplPlayer;
}
const players: FplPlayer[] = [];
for (let t = 1; t <= 20; t++) POS.forEach(([pid, short], i) => players.push(player(t * 10 + i, t, pid, short, ((t * 7 + i * 3) % 10) + 1)));
const EVENTS = [8, 9, 10, 11, 12, 13];
const WEEK = 7 * 86_400_000;
const firstDeadline = Date.now() + 2 * 86_400_000;
const makeData = (ps: FplPlayer[] = players): FplData => ({
  updatedAt: "2026-10-01T00:00:00Z", source: "test", seasonStatsThrough: 7,
  players: ps,
  fixtures: EVENTS.flatMap((ev) => Array.from({ length: 10 }, (_, k) => {
    const h = ((k * 2 + ev) % 20) + 1; const a = ((k * 2 + 1 + ev) % 20) + 1;
    return { id: ev * 100 + k, event: ev, teamH: h, teamA: a === h ? (a % 20) + 1 : a, teamHDifficulty: 3, teamADifficulty: 3, finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null };
  })),
  events: [{ id: 7, name: "Gameweek 7", deadline: new Date(firstDeadline - WEEK).toISOString(), current: true, next: false, finished: true, dataChecked: true }, ...EVENTS.map((id) => ({ id, name: `Gameweek ${id}`, deadline: new Date(firstDeadline + (id - 8) * WEEK).toISOString(), current: false, next: id === 8, finished: false, dataChecked: false }))],
  teams: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Team ${i + 1}`, short: `T${i + 1}` })),
  rules: { budget: 100, squadSize: 15, teamLimit: 3, positions: [
    { id: 1, name: "Goalkeeper", short: "GKP", squad: 2, minPlay: 1, maxPlay: 1 },
    { id: 2, name: "Defender", short: "DEF", squad: 5, minPlay: 3, maxPlay: 5 },
    { id: 3, name: "Midfielder", short: "MID", squad: 5, minPlay: 2, maxPlay: 5 },
    { id: 4, name: "Forward", short: "FWD", squad: 3, minPlay: 1, maxPlay: 3 },
  ] },
} as unknown as FplData);
const data = makeData();
const pick = (t: number, i: number) => t * 10 + i;
const SQUAD = [pick(1, 0), pick(2, 0), pick(3, 1), pick(3, 2), pick(4, 1), pick(4, 2), pick(5, 1), pick(6, 3), pick(6, 4), pick(7, 3), pick(7, 4), pick(8, 3), pick(9, 5), pick(10, 5), pick(11, 5)];
const byId = new Map(players.map((p) => [p.id, p]));
const tenths = (id: number) => Math.round(byId.get(id)!.price * 10);
const ev = (id: number) => data.events.find((e) => e.id === id)!;
/** First-half chips with the given stop GW; `played` chips are used, `pending` is armed. Second-half chips are never available here. */
function chipList(stop: number, opts: { available?: OfficialChip[]; pending?: OfficialChip | null } = {}): BotMyTeamChip[] {
  const available = opts.available ?? ["wildcard", "freehit", "bboost", "3xc"];
  return (["wildcard", "freehit", "bboost", "3xc"] as OfficialChip[]).flatMap((name) => [
    { name, status_for_entry: available.includes(name) || opts.pending === name ? "available" : "played", is_pending: opts.pending === name, start_event: name === "wildcard" || name === "freehit" ? 2 : 1, stop_event: stop, number: 1, chip_type: "x", played_by_entry: [] },
    { name, status_for_entry: "available", is_pending: false, start_event: stop + 1, stop_event: 38, number: 1, chip_type: "x", played_by_entry: [] },
  ]);
}
const team = (chips: BotMyTeamChip[], squad = SQUAD): BotMyTeam => ({
  picks: squad.map((element, i) => ({ element, position: i + 1, multiplier: i < 11 ? 1 : 0, is_captain: i === 0, is_vice_captain: i === 1, selling_price: tenths(element), purchase_price: tenths(element) })),
  transfers: { bank: 15, limit: 1, made: 0, cost: 0 },
  chips,
});
const plan = (over: Partial<PlanInput> & { myTeam: BotMyTeam }) =>
  planGameweek({ data, event: ev(8), hitPolicy: DEFAULT_HIT_POLICY, chipPolicy: "all", recentHitPoints: 0, allowTransfers: false, allowNewTeamChip: true, ...over });
const lineupStep = (myTeam: BotMyTeam, gw = 8, d = data) => planGameweek({ data: d, myTeam, event: d.events.find((e) => e.id === gw)!, hitPolicy: DEFAULT_HIT_POLICY, chipPolicy: "all", recentHitPoints: 0, allowTransfers: false, allowNewTeamChip: true });
const finalStep = (myTeam: BotMyTeam, gw = 8, d = data) => planGameweek({ data: d, myTeam, event: d.events.find((e) => e.id === gw)!, hitPolicy: DEFAULT_HIT_POLICY, chipPolicy: "all", recentHitPoints: 0, allowTransfers: false, allowNewTeamChip: false });

const baseLineup = buildLineup(SQUAD.map((id) => byId.get(id)!), data, 8);
test("fixture premise: the synthetic captain is below the normal 9-xPts TC bar (so only the expiry rule can play TC)", () => {
  assert.ok(baseLineup.captainXpts < CHIP_GUARDS.tripleCaptainMinXpts, `captain ${baseLineup.captainXpts}`);
  assert.ok(baseLineup.captainEligible);
});

// ---------------------------------------------------------------- expiry detection ----------------------------------
test("expiryState: 4 unused chips are tight only once chips > GWs left - buffer, and reserve distinct GWs keeping one spare", () => {
  const events = Array.from({ length: 19 }, (_, i) => ({ id: i + 1, finished: i + 1 < 14 })) as never;
  const t = team(chipList(19));
  const all: OfficialChip[] = ["wildcard", "freehit", "bboost", "3xc"];
  assert.deepEqual(expiryState(t, events, 14, all).urgentChips, [], "GW14: 6 GWs left for 4 chips -> not urgent (no premature activation)");
  const at15 = expiryState(t, Array.from({ length: 19 }, (_, i) => ({ id: i + 1, finished: i + 1 < 15 })) as never, 15, all);
  assert.deepEqual(at15.urgentChips, all);
  assert.deepEqual(at15.reservedGws, [15, 16, 17, 18], "GW19 stays spare");
  assert.equal(new Set(at15.reservedGws).size, at15.reservedGws.length, "distinct GWs");
});

test("expiryState: a single chip is reserved for GW E-1 (GW E spare); played chips and other-half chips do not count", () => {
  const evs = (from: number) => Array.from({ length: 19 }, (_, i) => ({ id: i + 1, finished: i + 1 < from })) as never;
  const t = team(chipList(19, { available: ["3xc"] }));
  assert.deepEqual(expiryState(t, evs(17), 17, ["3xc"]).urgentChips, []);
  assert.deepEqual(expiryState(t, evs(18), 18, ["3xc"]).reservedGws, [18]);
  assert.deepEqual(expiryState(t, evs(19), 19, ["3xc"]).reservedGws, [19], "last chance still reserved");
  // A chip whose window is not open at this GW (second-half entry) is not "available" -> chipStop null -> not counted.
  assert.deepEqual(expiryState(team(chipList(19, { available: [] })), evs(18), 18, ["3xc"]).urgentChips, []);
});

test("expiryState: more chips than GWs reserves every remaining GW (spare used too)", () => {
  const evs = Array.from({ length: 19 }, (_, i) => ({ id: i + 1, finished: i + 1 < 18 })) as never;
  const s = expiryState(team(chipList(19)), evs, 18, ["wildcard", "freehit", "bboost", "3xc"]);
  assert.deepEqual(s.reservedGws, [18, 19]);
});

test("pickExpiryChip: use-or-lose first, then value; null (unsafe / below bar) and value <= 0 are never forced", () => {
  assert.equal(pickExpiryChip([{ chip: "3xc", value: 7, finalGw: false }, { chip: "bboost", value: 3, finalGw: true }]), "bboost", "a positive chip in its last GW is not lost to another chip");
  assert.equal(pickExpiryChip([{ chip: "3xc", value: 7, finalGw: false }, { chip: "bboost", value: 9, finalGw: false }]), "bboost");
  assert.equal(pickExpiryChip([{ chip: "wildcard", value: null, finalGw: true }, { chip: "3xc", value: 0, finalGw: true }]), null);
  assert.equal(pickExpiryChip([{ chip: "bboost", value: CHIP_GUARDS.expiryMinValue, finalGw: true }]), null, "effectively-zero value is not forced");
  assert.equal(pickExpiryChip([{ chip: "freehit", value: 5, finalGw: false }, { chip: "3xc", value: 5, finalGw: false }]), "3xc", "deterministic tie order");
  assert.equal(pickExpiryChip([]), null);
});

// ---------------------------------------------------------------- early expiry planning (planner) --------------------
test("planner: two team chips with two GWs left are spread over distinct GWs and both used (no last-week pile-up)", () => {
  // stop = 9: at GW8 the window 8..9 holds 2 chips -> tight, reserved GW8 + GW9 (more chips than buffer allows).
  const gw8 = lineupStep(team(chipList(9, { available: ["bboost", "3xc"] })));
  assert.ok(gw8.lineupChip === "3xc" || gw8.lineupChip === "bboost", `GW8 spends one chip: ${gw8.reasons.join(" | ")}`);
  assert.ok(gw8.reasons.some((r) => r.startsWith("expiry:")));
  const left = (gw8.lineupChip === "3xc" ? ["bboost"] : ["3xc"]) as OfficialChip[];
  const gw9 = lineupStep(team(chipList(9, { available: left })), 9, { ...data, events: data.events.map((e) => (e.id === 8 ? { ...e, finished: true } : e)) });
  assert.equal(gw9.lineupChip, left[0], "the other chip gets its own GW");
});

test("planner: far from expiry the expiry rule forces nothing (only the normal scheduled+guard path can play a chip)", () => {
  const p = lineupStep(team(chipList(13, { available: ["bboost", "3xc"] })));
  assert.ok(!p.reasons.some((r) => r.startsWith("expiry")), p.reasons.join(" | "));
  // This synthetic bench is fully nailed (all 0.89) with net 9+ xPts, so the NORMAL guard may play BB when the portfolio
  // schedules it - same as before P1. TC (captain < 9) is never played away from expiry.
  assert.notEqual(p.lineupChip, "3xc");
  if (p.lineupChip === "bboost") assert.ok(p.reasons.some((r) => r.includes("chip portfolio schedules bboost")));
  const tcOnly = lineupStep(team(chipList(13, { available: ["3xc"] })));
  assert.equal(tcOnly.lineupChip, null);
});

test("planner: only the expiry-tight window is reserved; a later window does not force anything", () => {
  const p = lineupStep(team(chipList(13, { available: ["3xc"] })));
  assert.equal(p.lineupChip, null);
});

// ---------------------------------------------------------------- pending chip: late news vs expiry rule -------------
test("final step: TC activated under the expiry rule is NOT cancelled by the normal 9-xPts threshold", () => {
  const myTeam = team(chipList(8, { available: [], pending: "3xc" }));
  const p = finalStep(myTeam);
  assert.equal(p.lineupChip, "3xc", p.reasons.join(" | "));
  assert.ok(p.reasons.some((r) => r.includes("expiry rule: keeping 3xc")));
});

test("final step: outside an expiry GW the normal threshold still cancels a weak pending TC (unchanged behaviour)", () => {
  const p = finalStep(team(chipList(13, { available: ["wildcard", "freehit", "bboost"], pending: "3xc" })));
  assert.equal(p.lineupChip, null);
  assert.ok(p.reasons.includes("late news: triple captain cancelled (captain projection fell)"));
});

test("late injury: captain ruled out in an expiry GW -> armband moves, TC is kept on the new captain", () => {
  const injured = makeData(players.map((p) => (p.id === baseLineup.captainId ? { ...p, status: "i", chance: 0 } : p)));
  const p = finalStep(team(chipList(8, { available: [], pending: "3xc" })), 8, injured);
  assert.notEqual(p.lineup.captainId, baseLineup.captainId);
  assert.equal(p.lineupChip, "3xc");
});

test("late injury: no armband-eligible captain left -> TC cancelled even under the expiry rule (real late news)", () => {
  const allOut = makeData(players.map((p) => (SQUAD.includes(p.id) ? { ...p, status: "i", chance: 0, epNext: 0 } : p)));
  const p = finalStep(team(chipList(8, { available: [], pending: "3xc" })), 8, allOut);
  assert.equal(p.lineupChip, null);
  assert.ok(p.reasons.some((r) => r.includes("cancelled under the expiry rule")));
});

test("negative/zero value: pending BB with a worthless bench is cancelled; a zero-value BB is never forced", () => {
  // Whole squad ruled out (FPL also zeroes ep_next for such players): every slot projects ~0, the boost is worth nothing.
  const benchOut = makeData(players.map((p) => (SQUAD.includes(p.id) ? { ...p, status: "i", chance: 0, epNext: 0 } : p)));
  const cancelled = finalStep(team(chipList(8, { available: [], pending: "bboost" })), 8, benchOut);
  assert.equal(cancelled.lineupChip, null, cancelled.reasons.join(" | "));
  const notForced = lineupStep(team(chipList(8, { available: ["bboost"] })), 8, benchOut);
  assert.equal(notForced.lineupChip, null, "BB with net value <= 0 is let expire");
});

test("negative value: an urgent Wildcard that does not clear its +4 expiry bar is never forced", () => {
  // Squad = the optimiser's own rebuild => a wildcard gains ~0.
  const optimal = rebuildSquad(data, SQUAD.map((id) => byId.get(id)!), 1.5, new Map(SQUAD.map((id) => [id, byId.get(id)!.price])), "Balanced 5 GWs").map((p) => p.id);
  const p = planGameweek({ data, myTeam: team(chipList(8, { available: ["wildcard"] }), optimal), event: ev(8), hitPolicy: DEFAULT_HIT_POLICY, chipPolicy: "all", recentHitPoints: 0, allowTransfers: true });
  assert.equal(p.transferChip, null, p.reasons.join(" | "));
  assert.ok(p.reasons.some((r) => r.includes("wildcard rebuild") && r.includes("expiry check") && r.includes("not forced")), p.reasons.join(" | "));
});

// ---------------------------------------------------------------- Bench Boost guard ----------------------------------
test("BB guard: a backup GK (start ~0.16) no longer vetoes; weak outfield bench, unplayable GK or low net value still block", () => {
  const good = { outfieldBenchStartProbs: [0.9, 0.85, 0.8], benchGkPlayable: true, benchNetXpts: 9 };
  assert.equal(benchBoostGuardOk(good), true);
  assert.equal(benchBoostGuardOk({ ...good, outfieldBenchStartProbs: [0.9, 0.85, 0.17] }), false, "fodder outfielder blocks");
  assert.equal(benchBoostGuardOk({ ...good, benchGkPlayable: false }), false, "injured / blank bench GK blocks");
  assert.equal(benchBoostGuardOk({ ...good, benchNetXpts: 7.9 }), false, "net bench value below 8 blocks");
});

test("BB net value = bench xPts minus expected autosub points (no double counting of the autosub baseline)", () => {
  assert.ok(baseLineup.benchAutosubXpts > 0);
  assert.ok(Math.abs(baseLineup.benchNetXpts - (baseLineup.benchXpts - baseLineup.benchAutosubXpts)) < 1e-9);
});

// ---------------------------------------------------------------- safety regressions --------------------------------
test("safety: pre-first-deadline never plays a chip even in an expiry-tight window", () => {
  const p = planGameweek({ data, myTeam: { ...team(chipList(8)), transfers: { bank: 15, limit: null, made: 0 } }, event: ev(8), hitPolicy: DEFAULT_HIT_POLICY, chipPolicy: "all", recentHitPoints: 0, allowTransfers: false, allowNewTeamChip: true, preFirstDeadline: true });
  assert.equal(p.lineupChip, null);
  assert.equal(p.transferChip, null);
});

test("safety: chip policy none / cancellable are respected by the expiry rule", () => {
  assert.equal(plan({ myTeam: team(chipList(8)), chipPolicy: "none" }).lineupChip, null);
  const c = planGameweek({ data, myTeam: team(chipList(8, { available: ["wildcard", "freehit"] })), event: ev(8), hitPolicy: DEFAULT_HIT_POLICY, chipPolicy: "cancellable", recentHitPoints: 0, allowTransfers: true });
  assert.equal(c.transferChip, null, "WC/FH never forced under 'cancellable'");
});

test("safety: a pending chip blocks any other chip and is never sent again", () => {
  const wc = planGameweek({ data, myTeam: { ...team(chipList(8, { available: ["bboost", "3xc"], pending: "wildcard" })), transfers: { bank: 15, limit: null, made: 0 } }, event: ev(8), hitPolicy: DEFAULT_HIT_POLICY, chipPolicy: "all", recentHitPoints: 0, allowTransfers: true });
  assert.equal(wc.transferChip, null, "never re-sent");
  assert.equal(wc.lineupChip, null, "one chip per GW");
  const bb = lineupStep(team(chipList(8, { available: ["3xc"], pending: "bboost" })));
  assert.ok(bb.lineupChip === "bboost" || bb.lineupChip === null);
  assert.notEqual(bb.lineupChip, "3xc");
});

test("safety: an expiry-forced chip still produces a legal, validator-clean picks payload", () => {
  const p = lineupStep(team(chipList(8, { available: ["3xc"] })));
  assert.equal(p.lineupChip, "3xc");
  const elements = elementsFromData(data);
  assert.deepEqual(validateSquadIds(p.finalSquad, elements), []);
  const picks = buildPicksPayload(p.lineup, elements, p.lineupChip);
  const errors = validatePicksPayload(picks, { squadIds: p.finalSquad, elements, myTeam: team(chipList(8, { available: ["3xc"] })), event: 8, nowMs: 0, deadlineMs: Number.MAX_SAFE_INTEGER, deadlineGuardMs: 0, transferChipThisGw: false });
  assert.deepEqual(errors, []);
});

test("determinism: identical inputs give identical plans", () => {
  const a = lineupStep(team(chipList(9, { available: ["bboost", "3xc"] })));
  const b = lineupStep(team(chipList(9, { available: ["bboost", "3xc"] })));
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------- premature BB guard (P1 follow-up) ----------------
const weakenedPlayers = (id: number) => players.map((p) => (p.id === id ? { ...p, priorMinutes: 0, priorStarts: 0, minutes: 0, starts: 0, pointsPerGame: 0, priorPointsPerGame: 0, form: 0, epNext: 0 } : p));
test("BB regression ('Walle Egeli'): fixing the one weak outfield bench player alone cannot cause an early BB", () => {
  const benchOutfield = baseLineup.bench.slice(1);
  const fodder = benchOutfield[benchOutfield.length - 1];
  const weak = makeData(weakenedPlayers(fodder));
  const chips = team(chipList(13, { available: ["bboost"] }));
  const before = lineupStep(chips, 8, weak);
  const after = lineupStep(chips, 8, data); // the same player now nailed: ordinary guard passes
  const shadow = (r: string[]) => r.find((x) => x.startsWith("bench boost check (shadow)")) ?? "";
  assert.equal(before.lineupChip, null);
  assert.ok(shadow(before.reasons).includes("ordinary guard fails"), shadow(before.reasons));
  assert.ok(shadow(after.reasons).includes("ordinary guard passes"), shadow(after.reasons));
  assert.ok(shadow(after.reasons).includes("exceptional week no"));
  assert.ok(baseLineup.benchNetXpts < CHIP_GUARDS.benchBoostExceptionalNetXpts);
  assert.equal(after.lineupChip, null, "ordinary guard alone never plays BB in a normal week");
  // Final step of a normal week cancels a pending BB by the same activation rule.
  assert.equal(finalStep(team(chipList(13, { available: [], pending: "bboost" }))).lineupChip, null);
});

test("BB exceptional week: confirmed doubles for >= 3 bench players, or net bench >= 16; one double is not enough", () => {
  const teamOf = (id: number) => byId.get(id)!.teamId;
  const withDoubles = (n: number) => ({ ...data, fixtures: [...data.fixtures, ...baseLineup.bench.slice(0, n).map((id, k) => ({ ...data.fixtures[0], id: 9000 + k, event: 8, teamH: teamOf(id), teamA: ((teamOf(id) + 9) % 20) + 1 }))] });
  assert.equal(benchBoostExceptional(baseLineup, data, 8).ok, false);
  assert.equal(benchBoostExceptional(baseLineup, withDoubles(1), 8).ok, false);
  const three = benchBoostExceptional(baseLineup, withDoubles(3), 8);
  assert.equal(three.ok, true);
  assert.equal(three.dgwBench, 3);
  assert.equal(benchBoostExceptional({ ...baseLineup, benchNetXpts: 16 }, data, 8).ok, true);
});

test("BB in an expiry window is still played on the ordinary value (no exceptional week needed)", () => {
  const p = lineupStep(team(chipList(8, { available: ["bboost"] })));
  assert.equal(p.lineupChip, "bboost");
  assert.ok(p.reasons.some((r) => r.includes("expiry rule: bboost spent")));
});

// ---------------------------------------------------------------- WC expiry value ------------------------------------
test("WC expiry value: best of annealer and seeded search, legal 15 on the real budget, vs the free-transfer path", () => {
  const squad = SQUAD.map((id) => byId.get(id)!);
  const selling = new Map(SQUAD.map((id) => [id, byId.get(id)!.price]));
  const annealed = rebuildSquad(data, squad, 1.5, selling, "Balanced 5 GWs");
  const x = wildcardExpiryValue(data, squad, 1.5, selling, 1, annealed);
  assert.equal(x.squad.length, 15);
  assert.deepEqual(validateSquadIds(x.squad.map((p) => p.id), elementsFromData(data)), []);
  const budget = 15 + SQUAD.reduce((s, id) => s + tenths(id), 0);
  assert.ok(x.squad.reduce((s, p) => s + tenths(p.id), 0) <= budget, "within bank + selling prices");
  assert.ok(Math.abs(x.net - (x.wcPoints - x.regularPoints)) < 1e-9);
  assert.equal(x.horizon.length, 5);
  assert.equal(x.freeTransfersUsed, 1);
  const zeroFt = wildcardExpiryValue(data, squad, 1.5, selling, 0, annealed);
  assert.ok(zeroFt.regularPoints <= x.regularPoints + 1e-9, "fewer free transfers => weaker regular path");
});
