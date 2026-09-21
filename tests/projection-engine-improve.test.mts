import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECTION_MODEL_VERSION,
  projectionMetrics,
  availability,
  type FplFixture,
  type FplPlayer,
} from "../app/lib/fpl.ts";
import {
  availabilityForHorizon,
  availabilityForEvent,
  parseSuspensionDurationGws,
  nextRoundAvailability,
} from "../app/lib/availability.ts";
import { fixturesForPlayerEvent, isBlankGameweek, isDoubleGameweek } from "../app/lib/fixtures.ts";
import { ProjectionMetricsCache, projectionCacheKey } from "../app/lib/projection-cache.ts";
import { explainPlanPath, type FuturePlan } from "../app/lib/transfer-engine/plan.ts";
import { optimalSquadWeek } from "../app/lib/transfer-engine/squad-ep.ts";
import { modelRelease } from "../app/lib/model-version.ts";
import { readFileSync } from "node:fs";

function makePlayer(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1, name: "Test", firstName: "Test", secondName: "Player", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: 3, position: "Midfielder", positionShort: "MID", price: 6, status: "a", chance: null,
    epNext: 2, form: 2, pointsPerGame: 3, priorPointsPerGame: 3, priorMinutes: 1500, priorStarts: 20,
    priorExpectedGoals: 3, priorExpectedAssists: 3, priorBonus: 10, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 100, totalPoints: 0, eventPoints: 0, eventMinutes: 0, eventBonus: 0, eventDefensiveContribution: 0, selectedBy: 10, priceChange: 0, priceProjectionToday: 0, priceChangeSinceStart: 0, priceOutlook: [],
    transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0,
    expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 0,
    starts: 0, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0,
    penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
    priorSource: "official-pl-history",
    ...overrides,
  };
}

function makeFixture(overrides: Partial<FplFixture> = {}): FplFixture {
  return {
    id: 1, event: 1, teamH: 1, teamA: 2, teamHDifficulty: 3, teamADifficulty: 3,
    finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null,
    ...overrides,
  };
}

test("model version bumped to r7 and registered as current", () => {
  assert.equal(PROJECTION_MODEL_VERSION, "fpl-edge-2026.09.21-r7");
  const release = modelRelease(PROJECTION_MODEL_VERSION);
  assert.ok(release);
  assert.equal(release!.current, true);
});

test("H1: next-round injury % does NOT persist flat across horizon (JP case)", () => {
  const jp = makePlayer({
    id: 165, name: "João Pedro", teamId: 8, positionId: 4, positionShort: "FWD",
    status: "d", chance: 75, news: "Knee injury - 75% chance of playing", newsAdded: null,
    priorMinutes: 2658, priorStarts: 31, minutes: 360, starts: 4, selectedBy: 66.4,
    teamMatchesPlayed: 5, expectedGoals: 3.2, expectedAssists: 1.1, priorExpectedGoals: 12, priorExpectedAssists: 5,
  });
  const fixtures = [6, 7, 8, 9, 10].map((e, i) => makeFixture({ id: i + 1, event: e, teamH: 8, teamA: 1 }));
  const series = [6, 7, 8, 9, 10].map((e) => projectionMetrics(jp, e, fixtures, 6));
  // GW+0 still depressed by official 75%
  assert.ok(series[0].expectedMinutes < 70, `GW+0 mins ${series[0].expectedMinutes} should reflect 75% flag`);
  assert.equal(series[0].availabilityState, "DOUBTFUL");
  // Later GWs must recover — never identical 58-min yellow-flag persistence
  assert.ok(series[1].expectedMinutes > series[0].expectedMinutes + 5, "GW+1 must recover minutes");
  assert.ok(series[2].expectedMinutes > series[0].expectedMinutes + 8, "GW+2 must recover further");
  assert.ok(series[4].startProbability > series[0].startProbability + 0.1, "start% recovers across horizon");
  const uniqueMins = new Set(series.map((s) => Math.round(s.expectedMinutes)));
  assert.ok(uniqueMins.size >= 3, `minutes must vary across horizon, got ${[...uniqueMins]}`);
});

test("H1: suspension uses exact multi-GW duration then returns", () => {
  assert.equal(parseSuspensionDurationGws("3 match ban", "s"), 3);
  assert.equal(parseSuspensionDurationGws("One-match ban", "s"), 1);
  const banned = makePlayer({ status: "s", chance: 0, news: "Suspended — 2 match ban" });
  const g0 = availabilityForHorizon(banned, 0);
  const g1 = availabilityForHorizon(banned, 1);
  const g2 = availabilityForHorizon(banned, 2);
  assert.equal(g0.state, "SUSPENDED");
  assert.equal(g0.availability, 0);
  assert.equal(g1.state, "SUSPENDED");
  assert.equal(g2.state, "AVAILABLE");
  assert.equal(g2.availability, 1);
});

test("H2: Palmer-like priorStarts/38 incomplete-prior tax is reduced when nailed", () => {
  const palmer = makePlayer({
    id: 154, name: "Palmer", teamId: 8, positionShort: "MID", status: "a", chance: 100,
    priorStarts: 24, priorMinutes: 2100, starts: 5, minutes: 450, teamMatchesPlayed: 5,
    selectedBy: 45, priorExpectedGoals: 15, priorExpectedAssists: 10, expectedGoals: 2, expectedAssists: 2,
    penaltiesOrder: 1,
  });
  const fixtures = [makeFixture({ event: 6, teamH: 8, teamA: 1 })];
  const m = projectionMetrics(palmer, 6, fixtures, 6);
  // Old model ~77% start; fixed model should clear ~85%+ when 5/5 starts and chance=100
  assert.ok(m.startProbability >= 0.85, `Palmer start ${m.startProbability} should not stay taxed at ~77%`);
  assert.ok((m.expectedMinutes ?? 0) >= 75, `Palmer mins ${m.expectedMinutes}`);
  assert.equal(m.availabilityState, "AVAILABLE");
});

test("ExpectedMinutes = P(start)*E(min|start) + P(bench)*E(min|bench)", () => {
  const p = makePlayer({
    status: "a", chance: 100, priorStarts: 30, priorMinutes: 2700, starts: 5, minutes: 450, teamMatchesPlayed: 5,
  });
  const fixtures = [makeFixture({ event: 1, teamH: 1, teamA: 2 })];
  const m = projectionMetrics(p, 1, fixtures, 1);
  assert.ok(m.minutesIfStart !== undefined && m.minutesIfBench !== undefined && m.benchProbability !== undefined);
  const recomputed = m.startProbability! * m.minutesIfStart! + m.benchProbability! * m.minutesIfBench!;
  assert.ok(Math.abs(recomputed - m.expectedMinutes) < 0.05, `formula mismatch ${recomputed} vs ${m.expectedMinutes}`);
});

test("H4: riskMultiplier source no longer multiplies start into positive NET", () => {
  const src = readFileSync(new URL("../app/lib/transfer-engine/recommend.ts", import.meta.url), "utf8");
  assert.match(src, /H4/);
  assert.match(src, /0\.88 \+ confidence \* 0\.12/);
  assert.ok(!src.includes("0.55 + startProbability * 0.25 + confidence * 0.2"), "old start+conf double-count formula must be gone");
});

test("role security is exposed and does not claim to multiply xPts twice", () => {
  const p = makePlayer({ status: "a", chance: 100, priorStarts: 34, priorMinutes: 3000, starts: 5, minutes: 450, teamMatchesPlayed: 5 });
  const m = projectionMetrics(p, 1, [makeFixture()], 1);
  assert.ok((m.roleSecurity ?? 0) > 0.5);
  assert.ok((m.roleSecurity ?? 0) <= 1);
});

test("fixture authority helpers detect blank/DGW from official fixture array", () => {
  const fixtures = [
    makeFixture({ id: 1, event: 1, teamH: 1, teamA: 2 }),
    makeFixture({ id: 2, event: 2, teamH: 1, teamA: 3 }),
    makeFixture({ id: 3, event: 2, teamH: 4, teamA: 1 }),
  ];
  const player = makePlayer({ teamId: 1 });
  assert.equal(fixturesForPlayerEvent(fixtures, player, 1).length, 1);
  assert.equal(isBlankGameweek(fixtures, 1, 3), true);
  assert.equal(isDoubleGameweek(fixtures, 1, 2), true);
  assert.equal(isBlankGameweek(fixtures, 1, 1), false);
});

test("availability states cover AVAILABLE/DOUBTFUL/INJURED/SUSPENDED/RETURNING", () => {
  assert.equal(availabilityForHorizon(makePlayer({ status: "a", chance: 100 }), 0).state, "AVAILABLE");
  assert.equal(availabilityForHorizon(makePlayer({ status: "d", chance: 75 }), 0).state, "DOUBTFUL");
  assert.equal(availabilityForHorizon(makePlayer({ status: "i", chance: 25 }), 0).state, "INJURED");
  assert.equal(availabilityForHorizon(makePlayer({ status: "s", chance: 0, news: "1 match ban" }), 0).state, "SUSPENDED");
  assert.equal(availabilityForHorizon(makePlayer({ status: "d", chance: 75 }), 2).state, "RETURNING");
  assert.equal(nextRoundAvailability(makePlayer({ chance: 75 })), 0.75);
  assert.equal(availability(makePlayer({ chance: 75 })), 0.75);
  const sched = availabilityForEvent(makePlayer({ status: "d", chance: 75 }), 8, 6);
  assert.equal(sched.horizonOffset, 2);
});

test("structured path legs expose metrics for WHY THIS FUTURE MOVE drilldown", () => {
  const plan: FuturePlan = {
    steps: [
      { eventId: 6, action: "TRANSFER", outName: "A", inName: "B", outId: 1, inId: 2, hitCost: 4, freeTransfersBefore: 1, freeTransfersAfter: 1, grossEp: 55, discountedEp: 55 },
      { eventId: 7, action: "HOLD", hitCost: 0, freeTransfersBefore: 1, freeTransfersAfter: 2, grossEp: 52, discountedEp: 49.4 },
    ],
    discountedTotal: 100.4,
    undiscountedTotal: 107,
    hitCostTotal: 4,
    freeTransfersPath: [1, 2],
  };
  const legs = explainPlanPath(plan);
  assert.equal(legs.length, 2);
  assert.equal(legs[0].action, "TRANSFER");
  assert.equal(legs[0].netEp, 51); // 55 - 4
  assert.equal(legs[1].weeklyGross, 52);
  assert.match(legs[0].summary, /A→B/);
});

test("captaincy recalc preserved: optimalSquadWeek re-picks C/VC by xPts", () => {
  const squad = [
    makePlayer({ id: 1, positionShort: "GKP", positionId: 1, teamId: 1, priorStarts: 38, priorMinutes: 3420, starts: 5, minutes: 450, teamMatchesPlayed: 5 }),
    ...[2, 3, 4, 5, 6].map((id) => makePlayer({ id, positionShort: "DEF", positionId: 2, teamId: id, priorStarts: 35, priorMinutes: 3000, starts: 5, minutes: 450, teamMatchesPlayed: 5 })),
    ...[7, 8, 9, 10, 11].map((id) => makePlayer({ id, positionShort: "MID", positionId: 3, teamId: id, priorStarts: 35, priorMinutes: 3000, starts: 5, minutes: 450, teamMatchesPlayed: 5, epNext: id === 11 ? 8 : 3, expectedGoals: id === 11 ? 5 : 1 })),
    ...[12, 13, 14].map((id) => makePlayer({ id, positionShort: "FWD", positionId: 4, teamId: id, priorStarts: 30, priorMinutes: 2500, starts: 5, minutes: 400, teamMatchesPlayed: 5 })),
  ];
  const fixtures = squad.map((p, i) => makeFixture({ id: i + 1, event: 1, teamH: p.teamId, teamA: 99 }));
  const data = {
    updatedAt: "", source: "test", seasonStatsThrough: 0, players: squad, fixtures,
    events: [{ id: 1, name: "GW1", deadline: "2099-01-01", current: true, next: false, finished: false, dataChecked: false }],
    teams: squad.map((p) => ({ id: p.teamId, name: p.teamName, short: p.teamShort })),
    rules: { budget: 100, squadSize: 15, teamLimit: 3, positions: [
      { id: 1, name: "GKP", short: "GKP", squad: 2, minPlay: 1, maxPlay: 1 },
      { id: 2, name: "DEF", short: "DEF", squad: 5, minPlay: 3, maxPlay: 5 },
      { id: 3, name: "MID", short: "MID", squad: 5, minPlay: 2, maxPlay: 5 },
      { id: 4, name: "FWD", short: "FWD", squad: 3, minPlay: 1, maxPlay: 3 },
    ] },
  };
  const project = (p: FplPlayer, e: number) => projectionMetrics(p, e, fixtures, 1).xPts;
  const week = optimalSquadWeek(squad, 1, data as any, 1, project);
  assert.ok(week.captain, "captain must be selected");
  assert.ok(week.vice, "vice must be selected");
  assert.notEqual(week.captain!.id, week.vice!.id);
  // Captain should be highest xPts in XI
  const xiPts = week.xi.map((p) => ({ id: p.id, pts: project(p, 1) })).sort((a, b) => b.pts - a.pts);
  assert.equal(week.captain!.id, xiPts[0].id);
});

test("projection cache keys by player/GW/modelVersion/dataTimestamp", () => {
  const key = projectionCacheKey({ playerId: 165, eventId: 6, modelVersion: "r7", dataTimestamp: "t1" });
  assert.equal(key, "r7|t1|165|6");
  const cache = new ProjectionMetricsCache("r7", "t1");
  const metrics = projectionMetrics(makePlayer({ id: 165 }), 1, [makeFixture()], 1);
  cache.set(165, 6, metrics);
  assert.equal(cache.get(165, 6)?.xPts, metrics.xPts);
  assert.equal(cache.get(165, 7), undefined);
});

test("Thiago-like healthy pen taker keeps high minutes vs doubtful peer", () => {
  const fixtures = [6, 7, 8].map((e, i) => makeFixture({ id: i + 1, event: e, teamH: 3, teamA: 1 }));
  const thiago = makePlayer({
    id: 106, name: "Thiago", teamId: 3, positionShort: "FWD", positionId: 4, status: "a", chance: null,
    priorStarts: 37, priorMinutes: 3282, starts: 5, minutes: 442, teamMatchesPlayed: 5,
    penaltiesOrder: 1, selectedBy: 9, expectedGoals: 4, priorExpectedGoals: 14,
  });
  const jp = makePlayer({
    id: 165, name: "JP", teamId: 3, positionShort: "FWD", positionId: 4, status: "d", chance: 75,
    priorStarts: 31, priorMinutes: 2658, starts: 4, minutes: 360, teamMatchesPlayed: 5,
    selectedBy: 66, expectedGoals: 3, priorExpectedGoals: 12, news: "Knee injury - 75%",
  });
  const t0 = projectionMetrics(thiago, 6, fixtures, 6);
  const j0 = projectionMetrics(jp, 6, fixtures, 6);
  assert.ok(t0.expectedMinutes > j0.expectedMinutes, "healthy pen taker should have higher GW+0 mins");
  assert.ok(t0.startProbability > j0.startProbability);
  // By GW+2 JP recovers toward Thiago but Thiago pen role can still win xPts
  const t2 = projectionMetrics(thiago, 8, fixtures, 6);
  const j2 = projectionMetrics(jp, 8, fixtures, 6);
  assert.ok(j2.expectedMinutes > j0.expectedMinutes);
  assert.ok(t2.expectedMinutes > 80);
});

test("UI labels: TransferBreakdown moves optimizer utility to ADVANCED diagnostics", () => {
  const src = readFileSync(new URL("../app/components/TransferBreakdown.tsx", import.meta.url), "utf8");
  assert.match(src, /ADVANCED MODEL DIAGNOSTICS/);
  assert.match(src, /Not expected points/);
  assert.match(src, /Raw 5-GW NET vs HOLD/);
  assert.match(src, /WHY THIS FUTURE MOVE/);
  assert.match(src, /PROJECTION DEBUG/);
  assert.match(src, /DECISION CONFIDENCE/);
});
