/**
 * Any-week Triple Captain (P1 follow-up): TC may fire in any GW whose captain clears CHIP_GUARDS.tripleCaptainMinXpts.
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
/** Scale the base captain's projection inputs (k = 3 -> ~9.2 xPts, k = 2 -> ~7.0 xPts). */
const cap = baseLineup.captainId;
const boosted = (k: number) => makeData(players.map((p) => (p.id === cap ? { ...p, epNext: p.epNext * k, form: p.form * k, pointsPerGame: p.pointsPerGame * k, priorPointsPerGame: p.priorPointsPerGame * k, priorExpectedGoals: p.priorExpectedGoals * k } : p)));
/** Captain's club doubles in GW9, so the chip portfolio prefers GW9 for TC: GW8 is a genuinely unscheduled TC week. */
const capTeam = byId.get(cap)!.teamId;
const withGw9Double = (d: FplData): FplData => ({ ...d, fixtures: [...d.fixtures, { ...d.fixtures[0], id: 9901, event: 9, teamH: capTeam, teamA: ((capTeam + 9) % 20) + 1 }] });
const strong = withGw9Double(boosted(3));
const weak = withGw9Double(boosted(2));
const capXpts = (d: FplData) => buildLineup(SQUAD.map((id) => d.players.find((p) => p.id === id)!), d, 8);
const tcLine = (r: string[]) => r.find((x) => x.startsWith("triple captain check:")) ?? "";
void plan; void benchBoostExceptional; void benchBoostGuardOk; void wildcardExpiryValue; void expiryState; void pickExpiryChip; void rebuildSquad;

test("fixture premise: boosted captain clears the 9-xPts bar, weak one does not, same captain id", () => {
  const s = capXpts(boosted(3)); const w = capXpts(boosted(2));
  assert.equal(s.captainId, cap); assert.equal(w.captainId, cap);
  assert.ok(s.captainEligible && s.captainXpts >= CHIP_GUARDS.tripleCaptainMinXpts, `strong ${s.captainXpts}`);
  assert.ok(w.captainXpts < CHIP_GUARDS.tripleCaptainMinXpts, `weak ${w.captainXpts}`);
});

test("any-week TC: fires in an unscheduled, non-expiry GW when the captain is >= 9 xPts", () => {
  const p = lineupStep(team(chipList(13, { available: ["3xc"] })), 8, strong);
  assert.ok(!p.reasons.some((r) => r.includes("chip portfolio schedules 3xc")), p.reasons.join(" | "));
  assert.ok(!p.reasons.some((r) => r.startsWith("expiry")), "not an expiry GW");
  assert.equal(p.lineupChip, "3xc", p.reasons.join(" | "));
  assert.equal(p.lineup.captainId, cap);
  assert.ok(p.reasons.some((r) => r.startsWith("any-week TC:") && r.includes("not scheduled")));
  assert.match(tcLine(p.reasons), /captain 9\.\d xPts vs bar 9 - TC plays/);
});

test("any-week TC: does not fire below 9 xPts, and the check is still logged with projection and bar", () => {
  const p = lineupStep(team(chipList(13, { available: ["3xc"] })), 8, weak);
  assert.equal(p.lineupChip, null, p.reasons.join(" | "));
  assert.match(tcLine(p.reasons), /captain 7\.0 xPts vs bar 9 - below the bar, not played/);
  const base = lineupStep(team(chipList(13, { available: ["3xc"] })));
  assert.equal(base.lineupChip, null);
  assert.ok(tcLine(base.reasons).includes("below the bar"));
});

test("any-week TC: also fires at the transfer step (full phase) and is the only chip", () => {
  const p = planGameweek({ data: strong, myTeam: team(chipList(13, { available: ["3xc"] })), event: ev(8), hitPolicy: DEFAULT_HIT_POLICY, chipPolicy: "all", recentHitPoints: 0, allowTransfers: true });
  assert.equal(p.transferChip, null);
  assert.equal(p.lineupChip, "3xc", p.reasons.join(" | "));
});

test("any-week TC: never a second chip - a pending Bench Boost wins (kept) or blocks TC this tick (cancelled)", () => {
  // Urgent BB (window ends GW8) stays pending: BB is the GW's chip.
  const keptChips = [...chipList(8, { available: [], pending: "bboost" }).filter((c) => c.name !== "3xc"), ...chipList(13, { available: ["3xc"] }).filter((c) => c.name === "3xc")];
  const kept = lineupStep(team(keptChips), 8, strong);
  assert.equal(kept.lineupChip, "bboost", kept.reasons.join(" | "));
  assert.ok(tcLine(kept.reasons).includes("bboost is this GW's chip"), tcLine(kept.reasons));
  // Normal-week BB cancelled by late news: TC is NOT swapped in on the same payload (validator would reject it).
  const cancelled = lineupStep(team(chipList(13, { available: ["3xc"], pending: "bboost" })), 8, strong);
  assert.ok(cancelled.reasons.some((r) => r.startsWith("late news: bench boost cancelled")), cancelled.reasons.join(" | "));
  assert.equal(cancelled.lineupChip, null);
  assert.ok(tcLine(cancelled.reasons).includes("bboost is pending this GW"), tcLine(cancelled.reasons));
});

test("any-week TC: never a second chip - a pending Wildcard / Free Hit wins", () => {
  for (const chip of ["wildcard", "freehit"] as const) {
    const myTeam = { ...team(chipList(13, { available: ["bboost", "3xc"], pending: chip })), transfers: { bank: 15, limit: null, made: 0, cost: 0 } };
    const p = planGameweek({ data: strong, myTeam, event: ev(8), hitPolicy: DEFAULT_HIT_POLICY, chipPolicy: "all", recentHitPoints: 0, allowTransfers: true });
    assert.equal(p.transferChip, null, "pending chip never re-sent");
    assert.equal(p.lineupChip, null, `${chip}: ${p.reasons.join(" | ")}`);
    assert.ok(tcLine(p.reasons).includes(`${chip} is this GW's chip`), tcLine(p.reasons));
  }
});

test("expiry rule unchanged: TC is still spent in a reserved GW even below the 9-xPts bar", () => {
  for (const d of [data, weak]) {
    const p = lineupStep(team(chipList(8, { available: ["3xc"] })), 8, d);
    assert.equal(p.lineupChip, "3xc", p.reasons.join(" | "));
    assert.ok(p.reasons.some((r) => r.includes("expiry rule: 3xc spent")));
    assert.ok(!p.reasons.some((r) => r.startsWith("any-week TC:")));
  }
  const kept = finalStep(team(chipList(8, { available: [], pending: "3xc" })), 8, weak);
  assert.equal(kept.lineupChip, "3xc");
  assert.ok(kept.reasons.some((r) => r.includes("expiry rule: keeping 3xc")));
});

test("final step: a pending any-week TC is kept while >= 9, cancelled when the projection falls; never started in the final step", () => {
  const pending = team(chipList(13, { available: [], pending: "3xc" }));
  assert.equal(finalStep(pending, 8, strong).lineupChip, "3xc");
  const fell = finalStep(pending, 8, weak);
  assert.equal(fell.lineupChip, null);
  assert.ok(fell.reasons.includes("late news: triple captain cancelled (captain projection fell)"));
  const notStarted = finalStep(team(chipList(13, { available: ["3xc"] })), 8, strong);
  assert.equal(notStarted.lineupChip, null, "final window never starts a new chip");
  assert.ok(tcLine(notStarted.reasons).includes("final window never starts a new chip"));
});

test("safety: chip policy none, pre-first-deadline and a used TC never fire any-week TC", () => {
  assert.equal(lineupStep(team(chipList(13, { available: [] })), 8, strong).lineupChip, null);
  const none = planGameweek({ data: strong, myTeam: team(chipList(13, { available: ["3xc"] })), event: ev(8), hitPolicy: DEFAULT_HIT_POLICY, chipPolicy: "none", recentHitPoints: 0, allowTransfers: false, allowNewTeamChip: true });
  assert.equal(none.lineupChip, null);
  const pre = planGameweek({ data: strong, myTeam: { ...team(chipList(13, { available: ["3xc"] })), transfers: { bank: 15, limit: null, made: 0, cost: 0 } }, event: ev(8), hitPolicy: DEFAULT_HIT_POLICY, chipPolicy: "all", recentHitPoints: 0, allowTransfers: false, allowNewTeamChip: true, preFirstDeadline: true });
  assert.equal(pre.lineupChip, null);
});

test("safety: any-week TC yields a validator-clean picks payload and is deterministic", () => {
  const myTeam = team(chipList(13, { available: ["3xc"] }));
  const a = lineupStep(myTeam, 8, strong);
  const b = lineupStep(myTeam, 8, strong);
  assert.deepEqual(a, b);
  const elements = elementsFromData(strong);
  const picks = buildPicksPayload(a.lineup, elements, a.lineupChip);
  assert.equal(picks.chip, "3xc");
  assert.deepEqual(validatePicksPayload(picks, { squadIds: a.finalSquad, elements, myTeam, event: 8, nowMs: 0, deadlineMs: Number.MAX_SAFE_INTEGER, deadlineGuardMs: 0, transferChipThisGw: false }), []);
  assert.deepEqual(validateSquadIds(a.finalSquad, elements), []);
});
