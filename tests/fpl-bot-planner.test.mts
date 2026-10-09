import assert from "node:assert/strict";
import test from "node:test";
import type { FplData, FplPlayer } from "../app/lib/fpl.ts";
import { DEFAULT_HIT_POLICY, parseHitPolicy } from "../app/lib/fpl-bot/config.ts";
import { buildPicksPayload } from "../app/lib/fpl-bot/payloads.ts";
import { elementsFromData, planGameweek } from "../app/lib/fpl-bot/planner.ts";
import type { BotMyTeam } from "../app/lib/fpl-bot/types.ts";
import { validatePicksPayload, validateSquadIds } from "../app/lib/fpl-bot/validate.ts";

// Synthetic league: 20 clubs x (1 GK, 2 DEF, 2 MID, 1 FWD) = 120 players with varied quality / price.
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
const data: FplData = {
  updatedAt: new Date().toISOString(), source: "test", seasonStatsThrough: 7,
  players,
  fixtures: EVENTS.flatMap((event) => Array.from({ length: 10 }, (_, k) => {
    const h = ((k * 2 + event) % 20) + 1; const a = ((k * 2 + 1 + event) % 20) + 1;
    return { id: event * 100 + k, event, teamH: h, teamA: a === h ? (a % 20) + 1 : a, teamHDifficulty: 3, teamADifficulty: 3, finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null };
  })),
  events: [{ id: 7, name: "Gameweek 7", deadline: "2026-10-03T10:00:00Z", current: true, next: false, finished: true, dataChecked: true }, ...EVENTS.map((id) => ({ id, name: `Gameweek ${id}`, deadline: new Date(Date.parse("2026-10-10T10:00:00Z") + (id - 8) * 7 * 86_400_000).toISOString(), current: false, next: id === 8, finished: false, dataChecked: false }))],
  teams: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Team ${i + 1}`, short: `T${i + 1}` })),
  rules: { budget: 100, squadSize: 15, teamLimit: 3, positions: [
    { id: 1, name: "Goalkeeper", short: "GKP", squad: 2, minPlay: 1, maxPlay: 1 },
    { id: 2, name: "Defender", short: "DEF", squad: 5, minPlay: 3, maxPlay: 5 },
    { id: 3, name: "Midfielder", short: "MID", squad: 5, minPlay: 2, maxPlay: 5 },
    { id: 4, name: "Forward", short: "FWD", squad: 3, minPlay: 1, maxPlay: 3 },
  ] },
} as unknown as FplData;

// A legal, mediocre squad: GK from clubs 1-2, DEF 3-5 (x2 except 5), MID 6-8, FWD 9-11.
const pick = (t: number, i: number) => t * 10 + i;
const SQUAD = [pick(1, 0), pick(2, 0), pick(3, 1), pick(3, 2), pick(4, 1), pick(4, 2), pick(5, 1), pick(6, 3), pick(6, 4), pick(7, 3), pick(7, 4), pick(8, 3), pick(9, 5), pick(10, 5), pick(11, 5)];
const byId = new Map(players.map((p) => [p.id, p]));
const tenths = (id: number) => Math.round(byId.get(id)!.price * 10);
const team = (over: Partial<BotMyTeam> = {}): BotMyTeam => ({
  picks: SQUAD.map((element, i) => ({ element, position: i + 1, multiplier: i < 11 ? 1 : 0, is_captain: i === 0, is_vice_captain: i === 1, selling_price: tenths(element), purchase_price: tenths(element) })),
  transfers: { bank: 15, limit: 1, made: 0, cost: 0 },
  chips: [],
  ...over,
} as BotMyTeam);
const event = data.events.find((e) => e.id === 8)!;
const elements = elementsFromData(data);

test("fixture squad is legal", () => assert.deepEqual(validateSquadIds(SQUAD, elements), []));

test("planner (full control, no chips available): output is a legal squad + legal lineup within the hit policy", () => {
  const plan = planGameweek({ data, myTeam: team(), event, hitPolicy: DEFAULT_HIT_POLICY, chipPolicy: "all", recentHitPoints: 0, allowTransfers: true });
  assert.equal(plan.gw, 8);
  assert.ok(plan.legs.length <= 2, "1 FT + max one -4");
  assert.ok(plan.hitCost <= 4);
  assert.equal(plan.transferChip, null, "no chips are available in this my-team");
  assert.equal(plan.lineupChip, null);
  assert.deepEqual(validateSquadIds(plan.finalSquad, elements), []);
  const picks = buildPicksPayload(plan.lineup, elements, plan.lineupChip);
  const errors = validatePicksPayload(picks, { squadIds: plan.finalSquad, elements, myTeam: team(), event: 8, nowMs: 0, deadlineMs: Number.MAX_SAFE_INTEGER, deadlineGuardMs: 0, transferChipThisGw: false });
  assert.deepEqual(errors, []);
  assert.ok(plan.reasons.length > 0, "every plan explains itself");
});

test("planner: hits disabled => never a paid transfer; lineup-only => no transfers and no WC/FH", () => {
  const noHits = planGameweek({ data, myTeam: team(), event, hitPolicy: parseHitPolicy("none"), chipPolicy: "all", recentHitPoints: 0, allowTransfers: true });
  assert.equal(noHits.hitCost, 0);
  assert.ok(noHits.legs.length <= 1);
  const lineupOnly = planGameweek({ data, myTeam: team(), event, hitPolicy: DEFAULT_HIT_POLICY, chipPolicy: "all", recentHitPoints: 0, allowTransfers: false });
  assert.deepEqual(lineupOnly.legs, []);
  assert.equal(lineupOnly.transferChip, null);
  assert.deepEqual([...lineupOnly.finalSquad].sort(), [...SQUAD].sort());
});

test("planner: chip policy 'none' never plays a chip even when all are available", () => {
  const chips = (["wildcard", "freehit", "bboost", "3xc"] as const).map((name) => ({ name, status_for_entry: "available", played_by_entry: [], start_event: 1, stop_event: 19, is_pending: false }));
  const plan = planGameweek({ data, myTeam: team({ chips } as Partial<BotMyTeam>), event, hitPolicy: DEFAULT_HIT_POLICY, chipPolicy: "none", recentHitPoints: 0, allowTransfers: true });
  assert.equal(plan.transferChip, null);
  assert.equal(plan.lineupChip, null);
});
