import assert from "node:assert/strict";
import test from "node:test";
import { FplData, FplPlayer, ProjectionMetrics, projectionMetrics } from "../app/lib/fpl.ts";
import { createOptimizer, WeekPlan } from "../app/lib/optimizer.ts";
import { WILDCARD_WEIGHTS } from "../app/lib/wildcard-tuning.ts";
import {
  benchOpportunityCostPenalty,
  buildCaptaincyReferenceByEvent,
  captaincyEdgeBonus,
  correlationPenalty,
  gkStructureTerm,
  overperformancePenalty,
  priceFlexibilityBonus,
} from "../app/lib/wildcard-scoring.ts";

const totalCorrelation = (p: { defensive: number; attacking: number }) => p.defensive + p.attacking;

const T = WILDCARD_WEIGHTS.Balanced;

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
    ...overrides,
  };
}

function makeRules() {
  return {
    budget: 100, squadSize: 15, teamLimit: 3,
    positions: [
      { id: 1, name: "Goalkeeper", short: "GKP", squad: 2, minPlay: 1, maxPlay: 1 },
      { id: 2, name: "Defender", short: "DEF", squad: 5, minPlay: 3, maxPlay: 5 },
      { id: 3, name: "Midfielder", short: "MID", squad: 5, minPlay: 2, maxPlay: 5 },
      { id: 4, name: "Forward", short: "FWD", squad: 3, minPlay: 1, maxPlay: 3 },
    ],
  };
}

function makeData(overrides: Partial<FplData> = {}): FplData {
  return {
    updatedAt: new Date().toISOString(), source: "test", seasonStatsThrough: 0, players: [],
    fixtures: [], events: [], rules: makeRules(), teams: [], ...overrides,
  } as FplData;
}

// A real single fixture per call, not an empty array -- projectionMetrics' whole per-game xPts/xG/
// cleanSheetProbability computation is gated on games.length, so an empty fixtures list silently
// zeroes every one of those fields regardless of a player's real underlying stats.
const metricsFn = (player: FplPlayer, eventId: number): ProjectionMetrics =>
  projectionMetrics(player, eventId, [{ id: eventId, event: eventId, teamH: player.teamId, teamA: player.teamId + 10000, teamHDifficulty: 3, teamADifficulty: 3, finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null }], eventId);

// --- gkStructureTerm: two expensive GKs vs premium + cheap GK ---

test("gkStructureTerm: two expensive keepers with no rotation gain nets a pure penalty", () => {
  // Both keepers equally likely to start/score (same underlying rate) -- no genuine rotation
  // value, so the backup's price above the fodder floor is pure wasted spend.
  const gk1 = makePlayer({ id: 1, positionShort: "GKP", positionId: 1, price: 5.5, priorStarts: 20, priorMinutes: 1800 });
  const gk2 = makePlayer({ id: 2, positionShort: "GKP", positionId: 1, price: 5.3, priorStarts: 20, priorMinutes: 1800 });
  const weeks = [1, 2, 3].map((eventId) => ({ eventId, xi: [], bench: [], captain: gk1, vice: gk2, formation: "3-4-3", points: 0, captainPoints: 0, vicePoints: 0 } as WeekPlan));
  const term = gkStructureTerm([gk1, gk2], weeks, [1, 0.9, 0.8], metricsFn, T);
  assert.ok(term < 0, `expected a net penalty for two expensive keepers with no rotation gain, got ${term}`);
});

test("gkStructureTerm: a premium + realistic-fodder-price keeper pairing owes no premium penalty", () => {
  const premium = makePlayer({ id: 1, positionShort: "GKP", positionId: 1, price: 5.5, priorStarts: 20, priorMinutes: 1800 });
  const fodder = makePlayer({ id: 2, positionShort: "GKP", positionId: 1, price: 4.0, priorStarts: 2, priorMinutes: 100 });
  const weeks = [1, 2, 3].map((eventId) => ({ eventId, xi: [], bench: [], captain: premium, vice: fodder, formation: "3-4-3", points: 0, captainPoints: 0, vicePoints: 0 } as WeekPlan));
  const term = gkStructureTerm([premium, fodder], weeks, [1, 0.9, 0.8], metricsFn, T);
  assert.ok(term >= -0.01, `a backup priced at exactly minViableGkPrice should owe ~zero premium penalty, got ${term}`);
});

test("gkStructureTerm: a genuine rotation pair (backup outscores primary some weeks) earns back its premium", () => {
  // gkStructureTerm derives "primary" as whichever keeper costs MORE -- so the intended first-choice
  // keeper must be priced higher than both backup candidates for this comparison to be fair.
  const primary = makePlayer({ id: 1, positionShort: "GKP", positionId: 1, price: 5.0, priorStarts: 20, priorMinutes: 1800, priorSaves: 40 });
  const rotationBackup = makePlayer({ id: 2, positionShort: "GKP", positionId: 1, price: 4.5, priorStarts: 20, priorMinutes: 1800, priorSaves: 90 });
  const weeks = [1, 2, 3, 4, 5].map((eventId) => ({ eventId, xi: [], bench: [], captain: primary, vice: rotationBackup, formation: "3-4-3", points: 0, captainPoints: 0, vicePoints: 0 } as WeekPlan));
  const termWithRotation = gkStructureTerm([primary, rotationBackup], weeks, [1, 1, 1, 1, 1], metricsFn, T);
  const noRotationBackup = makePlayer({ id: 3, positionShort: "GKP", positionId: 1, price: 4.5, priorStarts: 20, priorMinutes: 1800, priorSaves: 20 });
  const termWithoutRotation = gkStructureTerm([primary, noRotationBackup], weeks, [1, 1, 1, 1, 1], metricsFn, T);
  assert.ok(termWithRotation > termWithoutRotation, "a backup that genuinely outscores the primary some weeks should score better than an equally-priced backup that never does");
});

// --- correlationPenalty: defensive double/triple-up vs attacking stacks ---

test("correlationPenalty: 3 defenders from one club costs more than 2, before any clean-sheet discount", () => {
  const club = (n: number) => makePlayer({ id: n, teamId: 1, positionShort: "DEF", positionId: 2, priorStarts: 0 });
  const two = [club(1), club(2)];
  const three = [club(1), club(2), club(3)];
  const twoPenalty = correlationPenalty(two, 1, metricsFn, T).defensive;
  const threePenalty = correlationPenalty(three, 1, metricsFn, T).defensive;
  assert.ok(threePenalty > twoPenalty, `3-DEF stack (${threePenalty}) should cost strictly more than a 2-DEF stack (${twoPenalty})`);
});

test("correlationPenalty: a defense with genuinely high modeled clean-sheet probability pays a shrunk penalty", () => {
  // cleanSheetProbability is driven by the club's own real team-quality defence factor (see
  // projectionMetrics in fpl.ts), not by a single defender's own defensiveContribution stat --
  // priorDefensiveContribution affects a different scoring component (DC points) entirely.
  const strongDefender = (n: number) => makePlayer({ id: n, teamId: 1, positionShort: "DEF", positionId: 2, priorStarts: 20, priorMinutes: 1800, teamQualityDefenceHome: 1.3, teamQualityDefenceAway: 1.3 });
  const weakDefender = (n: number) => makePlayer({ id: n, teamId: 2, positionShort: "DEF", positionId: 2, priorStarts: 20, priorMinutes: 1800, teamQualityDefenceHome: 0.7, teamQualityDefenceAway: 0.7 });
  // Both clubs get 2 defenders each (same count, isolated per-club in the function), so any
  // difference is purely the clean-sheet-probability discount, not stack size.
  const strongClub = [strongDefender(1), strongDefender(2)];
  const weakClub = [weakDefender(3), weakDefender(4)];
  const strongPenalty = correlationPenalty(strongClub, 1, metricsFn, T).defensive;
  const weakPenalty = correlationPenalty(weakClub, 1, metricsFn, T).defensive;
  assert.ok(strongPenalty < weakPenalty, `a stronger defensive unit (${strongPenalty}) should cost strictly less than a weaker one (${weakPenalty}) at the same stack size`);
});

test("correlationPenalty: attacking stacks are never penalized as heavily as defensive stacks of the same size", () => {
  const attacker = (n: number) => makePlayer({ id: n, teamId: 1, positionShort: "MID", positionId: 3 });
  const defender = (n: number) => makePlayer({ id: n, teamId: 2, positionShort: "DEF", positionId: 2, priorStarts: 0 });
  const attackPenalty = totalCorrelation(correlationPenalty([attacker(1), attacker(2), attacker(3)], 1, metricsFn, T));
  const defensePenalty = totalCorrelation(correlationPenalty([defender(4), defender(5), defender(6)], 1, metricsFn, T));
  assert.ok(attackPenalty < defensePenalty, `3-attacker stack (${attackPenalty}) must cost less than a 3-defender stack (${defensePenalty})`);
});

test("correlationPenalty: 2 attackers from one club is not penalized at all", () => {
  const attacker = (n: number) => makePlayer({ id: n, teamId: 1, positionShort: "MID", positionId: 3 });
  assert.equal(totalCorrelation(correlationPenalty([attacker(1), attacker(2)], 1, metricsFn, T)), 0);
});

// --- captaincyEdgeBonus ---

test("captaincyEdgeBonus: a squad with one standout captain option scores higher than one where captain and vice are near-tied", () => {
  const p = (id: number) => makePlayer({ id });
  const standoutWeeks = [1, 2, 3].map((eventId) => ({ eventId, xi: [], bench: [], captain: p(1), vice: p(2), formation: "3-4-3", points: 0, captainPoints: 12, vicePoints: 6 } as WeekPlan));
  const tiedWeeks = [1, 2, 3].map((eventId) => ({ eventId, xi: [], bench: [], captain: p(1), vice: p(2), formation: "3-4-3", points: 0, captainPoints: 9, vicePoints: 8.7 } as WeekPlan));
  const standoutBonus = captaincyEdgeBonus(standoutWeeks, [1, 0.9, 0.8], T);
  const tiedBonus = captaincyEdgeBonus(tiedWeeks, [1, 0.9, 0.8], T);
  assert.ok(standoutBonus > tiedBonus, `a real captaincy edge (${standoutBonus}) should score higher than a near-tied captain/vice (${tiedBonus})`);
});

test("captaincyEdgeBonus: never rewards a squad whose vice would outscore the nominal captain (never negative)", () => {
  const p = (id: number) => makePlayer({ id });
  const weeks = [{ eventId: 1, xi: [], bench: [], captain: p(1), vice: p(2), formation: "3-4-3", points: 0, captainPoints: 5, vicePoints: 8 } as WeekPlan];
  assert.equal(captaincyEdgeBonus(weeks, [1], T), 0);
});

// --- overperformancePenalty: high return, weak underlying vs genuine breakout ---

test("overperformancePenalty: actual output far ahead of xG+xA with a full minutes sample is penalized", () => {
  const hotStreak = makePlayer({ id: 1, minutes: 1350, goals: 10, assists: 5, expectedGoals: 3, expectedAssists: 2 });
  const penalty = overperformancePenalty([hotStreak], 1, metricsFn, T);
  assert.ok(penalty > 0, `a player running well ahead of their own underlying numbers over a full sample should be penalized, got ${penalty}`);
});

test("overperformancePenalty: the same output gap with a tiny minutes sample is discounted, not ignored but not full-strength", () => {
  const bigSample = makePlayer({ id: 1, minutes: 1350, goals: 6, assists: 2, expectedGoals: 2, expectedAssists: 1 });
  const tinySample = makePlayer({ id: 2, minutes: 90, goals: 6 / 15, assists: 2 / 15, expectedGoals: 2 / 15, expectedAssists: 1 / 15 });
  const bigPenalty = overperformancePenalty([bigSample], 1, metricsFn, T);
  const tinyPenalty = overperformancePenalty([tinySample], 1, metricsFn, T);
  assert.ok(tinyPenalty < bigPenalty, `a 90-minute sample (${tinyPenalty}) should be discounted well below a full-season sample of the same per-90 gap (${bigPenalty})`);
});

test("overperformancePenalty: a confirmed penalty-taker keeps only the discounted penalty, not the full amount", () => {
  const withoutRole = makePlayer({ id: 1, minutes: 1350, goals: 10, assists: 5, expectedGoals: 3, expectedAssists: 2, penaltiesOrder: null });
  const withRole = makePlayer({ id: 2, minutes: 1350, goals: 10, assists: 5, expectedGoals: 3, expectedAssists: 2, penaltiesOrder: 1 });
  const withoutRolePenalty = overperformancePenalty([withoutRole], 1, metricsFn, T);
  const withRolePenalty = overperformancePenalty([withRole], 1, metricsFn, T);
  assert.ok(withRolePenalty < withoutRolePenalty, "a confirmed penalty-taker's overperformance should be discounted relative to an identical player with no role");
  assert.ok(withRolePenalty > 0, "the role discount should reduce, not zero out, the penalty");
});

test("overperformancePenalty: a genuine breakout matching their underlying numbers is never penalized", () => {
  const breakout = makePlayer({ id: 1, minutes: 1350, goals: 8, assists: 4, expectedGoals: 7.5, expectedAssists: 3.8 });
  assert.equal(overperformancePenalty([breakout], 1, metricsFn, T), 0);
});

test("overperformancePenalty: a low-minute player who simply hasn't played enough to accrue any gap is never penalized", () => {
  const lowMinutes = makePlayer({ id: 1, minutes: 45, goals: 1, assists: 0, expectedGoals: 0.1, expectedAssists: 0.05 });
  const penalty = overperformancePenalty([lowMinutes], 1, metricsFn, T);
  assert.ok(penalty >= 0 && penalty < 1, `a single 45-minute cameo should contribute at most a negligible penalty, got ${penalty}`);
});

// --- benchOpportunityCostPenalty: excessive bench spend as opportunity cost, not a flat cutoff ---

test("benchOpportunityCostPenalty: an expensive, high-appearance-probability first bench player owes little or no penalty", () => {
  const usefulBench = makePlayer({ id: 1, positionShort: "DEF", positionId: 2, price: 5.5, priorStarts: 20, priorMinutes: 1800, status: "a", chance: null });
  const week = { eventId: 1, xi: [], bench: [usefulBench], captain: usefulBench, vice: usefulBench, formation: "3-4-3", points: 0, captainPoints: 0, vicePoints: 0 } as WeekPlan;
  const penalty = benchOpportunityCostPenalty([week], [1], metricsFn, T);
  assert.ok(penalty < 2, `a genuinely rotation-proof first bench player at £5.5m should owe little penalty, got ${penalty}`);
});

test("benchOpportunityCostPenalty: the same price on a rarely-playing third bench slot owes a real penalty", () => {
  const rarelyPlays = makePlayer({ id: 1, positionShort: "FWD", positionId: 4, price: 5.5, priorStarts: 1, priorMinutes: 60, status: "a", chance: null });
  // Padding two cheap, irrelevant slots ahead of it so it lands at bench index 2 (the third slot).
  const filler = (id: number) => makePlayer({ id, positionShort: "MID", positionId: 3, price: 4.0, priorStarts: 1, priorMinutes: 60 });
  const week = { eventId: 1, xi: [], bench: [filler(2), filler(3), rarelyPlays], captain: rarelyPlays, vice: rarelyPlays, formation: "3-4-3", points: 0, captainPoints: 0, vicePoints: 0 } as WeekPlan;
  const penalty = benchOpportunityCostPenalty([week], [1], metricsFn, T);
  assert.ok(penalty > 2, `a £5.5m third bench player who rarely plays should owe a real opportunity-cost penalty, got ${penalty}`);
});

// --- priceFlexibilityBonus: realistic one-transfer reachability ---

test("priceFlexibilityBonus: a squad with several close-price, similar-value alternatives in the pool scores higher than one with none", () => {
  const owned = makePlayer({ id: 1, positionShort: "MID", positionId: 3, price: 5.8, minutes: 900 });
  const closeAlternatives = [2, 3, 4].map((id) => makePlayer({ id, positionShort: "MID", positionId: 3, price: 6.0, minutes: 900 }));
  const noAlternatives = [5, 6, 7].map((id) => makePlayer({ id, positionShort: "GKP", positionId: 1, price: 6.0 }));
  const projectionValue = (p: FplPlayer) => (p.positionShort === "MID" ? 10 : 1);
  const withAlternatives = priceFlexibilityBonus([owned], [owned, ...closeAlternatives], projectionValue, T);
  const withoutAlternatives = priceFlexibilityBonus([owned], [owned, ...noAlternatives], projectionValue, T);
  assert.ok(withAlternatives > withoutAlternatives, `reachable same-position alternatives (${withAlternatives}) should score higher than none (${withoutAlternatives})`);
});

// --- Multi-horizon (3/5/8 GW) evaluation on the SAME squad ---

test("multi-horizon: the same squad's weighted points differ meaningfully across 3/5/8-GW HorizonModes", () => {
  const squad: FplPlayer[] = [];
  const gkps = [1, 2].map((n) => makePlayer({ id: n, positionShort: "GKP", positionId: 1, teamId: 100 + n, price: 4.5 }));
  const defs = [11, 12, 13, 14, 15].map((n) => makePlayer({ id: n, positionShort: "DEF", positionId: 2, teamId: n, price: 4.5 }));
  const mids = [21, 22, 23, 24, 25].map((n) => makePlayer({ id: n, positionShort: "MID", positionId: 3, teamId: n, price: 5.5 }));
  const fwds = [31, 32, 33].map((n) => makePlayer({ id: n, positionShort: "FWD", positionId: 4, teamId: n, price: 5.5 }));
  squad.push(...gkps, ...defs, ...mids, ...fwds);
  const events = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, name: `GW${i + 1}`, deadline: new Date(Date.now() + (i + 1) * 86400000).toISOString(), current: false, next: i === 0, finished: false, dataChecked: false }));
  const teamIds = [...new Set(squad.map((p) => p.teamId))];
  const fixtures = events.flatMap((event) => teamIds.map((teamId, i) => ({
    id: event.id * 100 + i, event: event.id, teamH: teamId, teamA: teamIds[(i + 1) % teamIds.length],
    teamHDifficulty: 3, teamADifficulty: 3, finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null,
  })));
  const data = makeData({ players: squad, events, fixtures });
  const threeGw = createOptimizer(data, "Next 3 GWs", "Balanced", "Maximum xPts").evaluate(squad);
  const fiveGw = createOptimizer(data, "Balanced 5 GWs", "Balanced", "Maximum xPts").evaluate(squad);
  const eightGw = createOptimizer(data, "Long-term 8 GWs", "Balanced", "Maximum xPts").evaluate(squad);
  assert.ok(threeGw.weightedPoints < fiveGw.weightedPoints, "5-GW weighted points should exceed 3-GW (more gameweeks counted)");
  assert.ok(fiveGw.weightedPoints < eightGw.weightedPoints, "8-GW weighted points should exceed 5-GW (more gameweeks counted)");
});

// --- 3 distinct Wildcard archetypes score the SAME representative squad differently ---

test("wildcard archetypes: Balanced/Safe/Aggressive tuning genuinely differs on the same squad, not just cosmetically", () => {
  const gk1 = makePlayer({ id: 1, positionShort: "GKP", positionId: 1, price: 5.5, priorStarts: 20, priorMinutes: 1800, priorSaves: 90 });
  const gk2 = makePlayer({ id: 2, positionShort: "GKP", positionId: 1, price: 5.2, priorStarts: 20, priorMinutes: 1800, priorSaves: 85 });
  const weeks = [1, 2, 3].map((eventId) => ({ eventId, xi: [], bench: [], captain: gk1, vice: gk2, formation: "3-4-3", points: 0, captainPoints: 14, vicePoints: 6 } as WeekPlan));
  const gkTermByArchetype = (Object.keys(WILDCARD_WEIGHTS) as (keyof typeof WILDCARD_WEIGHTS)[]).map((risk) => gkStructureTerm([gk1, gk2], weeks, [1, 1, 1], metricsFn, WILDCARD_WEIGHTS[risk]));
  const captaincyByArchetype = (Object.keys(WILDCARD_WEIGHTS) as (keyof typeof WILDCARD_WEIGHTS)[]).map((risk) => captaincyEdgeBonus(weeks, [1, 1, 1], WILDCARD_WEIGHTS[risk]));
  assert.ok(new Set(gkTermByArchetype.map((v) => v.toFixed(4))).size > 1, "the three archetypes must not score identical two-expensive-keeper squads the same");
  assert.ok(new Set(captaincyByArchetype.map((v) => v.toFixed(4))).size > 1, "the three archetypes must value the same captaincy edge differently");
  // Aggressive should reward the same captaincy edge the most (explicit design instruction);
  // "Balanced" RiskMode maps to the "Maximum Expected Points" archetype (ARCHETYPE_BY_RISK), which
  // deliberately carries the SMALLEST strategic-term weights of the three (it wants the closest
  // thing to undistorted raw expected points) -- so it sits below "Safe" (the middle "Balanced"
  // archetype), not above it. See wildcard-tuning.ts's top-of-file note on this axis.
  const [maxPoints, middle, aggressive] = ["Balanced", "Safe", "Aggressive"].map((r) => captaincyEdgeBonus(weeks, [1, 1, 1], WILDCARD_WEIGHTS[r as keyof typeof WILDCARD_WEIGHTS]));
  assert.ok(aggressive > middle && middle > maxPoints, `expected Aggressive (${aggressive}) > Balanced/middle archetype (${middle}) > Maximum Expected Points (${maxPoints}) captaincy-edge reward`);
});

// --- captaincyEdgeBonus: must not be gameable by owning a weaker vice, must reward real pool-wide edge ---

test("captaincyEdgeBonus: a squad cannot inflate its score merely by owning a worse vice-captain candidate", () => {
  // Same captain, same reference pool -- only the SQUAD's own vice gets worse. The old self-
  // referential formula (captain - own vice) would score `weakerVice` higher purely because its
  // vice is worse, with the captain choice itself unchanged -- exactly the flaw flagged for review.
  const strongCaptain = makePlayer({ id: 1, minutes: 900, expectedGoals: 8 });
  const decentVice = makePlayer({ id: 2, minutes: 900, expectedGoals: 4 });
  const weakVice = makePlayer({ id: 3, minutes: 900, expectedGoals: 0.5 });
  const pool = [strongCaptain, decentVice, weakVice, makePlayer({ id: 4, minutes: 900, expectedGoals: 3 })];
  const reference = buildCaptaincyReferenceByEvent(pool, [1, 2, 3], metricsFn, T.captaincyReferencePoolSize);
  const weeksDecentVice = [1, 2, 3].map((eventId) => ({
    eventId, xi: [], bench: [], captain: strongCaptain, vice: decentVice, formation: "3-4-3", points: 0,
    captainPoints: metricsFn(strongCaptain, eventId).xPts, vicePoints: metricsFn(decentVice, eventId).xPts,
  } as WeekPlan));
  const weeksWeakVice = weeksDecentVice.map((w) => ({ ...w, vice: weakVice, vicePoints: metricsFn(weakVice, w.eventId).xPts }));
  const bonusDecentVice = captaincyEdgeBonus(weeksDecentVice, [1, 1, 1], T, reference);
  const bonusWeakVice = captaincyEdgeBonus(weeksWeakVice, [1, 1, 1], T, reference);
  assert.equal(bonusDecentVice, bonusWeakVice, `swapping in a strictly worse vice-captain must not change the bonus (got ${bonusDecentVice} vs ${bonusWeakVice}) -- the captain choice itself did not change`);
});

test("captaincyEdgeBonus: rewards a captain who clears the pool-wide elite bar, not just their own squad's second-best", () => {
  // Two squads own the SAME weak captain and the SAME (even weaker) vice -- under the old formula
  // both would score an identical, nonzero "edge" purely from the internal gap. The pool differs:
  // one pool's best alternatives are all mediocre (this captain is a real relative standout), the
  // other pool has genuinely elite options this captain doesn't come close to.
  const captain = makePlayer({ id: 1, minutes: 900, expectedGoals: 3 });
  const vice = makePlayer({ id: 2, minutes: 900, expectedGoals: 0.5 });
  const weakPool = [captain, vice, makePlayer({ id: 3, minutes: 900, expectedGoals: 2.8 })];
  const elitePool = [captain, vice, ...[4, 5, 6, 7, 8].map((id) => makePlayer({ id, minutes: 900, expectedGoals: 12 }))];
  const weeks = [1, 2, 3].map((eventId) => ({
    eventId, xi: [], bench: [], captain, vice, formation: "3-4-3", points: 0,
    captainPoints: metricsFn(captain, eventId).xPts, vicePoints: metricsFn(vice, eventId).xPts,
  } as WeekPlan));
  const weakPoolReference = buildCaptaincyReferenceByEvent(weakPool, [1, 2, 3], metricsFn, T.captaincyReferencePoolSize);
  const elitePoolReference = buildCaptaincyReferenceByEvent(elitePool, [1, 2, 3], metricsFn, T.captaincyReferencePoolSize);
  const bonusAgainstWeakPool = captaincyEdgeBonus(weeks, [1, 1, 1], T, weakPoolReference);
  const bonusAgainstElitePool = captaincyEdgeBonus(weeks, [1, 1, 1], T, elitePoolReference);
  assert.ok(bonusAgainstWeakPool > bonusAgainstElitePool, `the same mediocre captain should score a real edge against a mediocre pool (${bonusAgainstWeakPool}) but little or none against a pool with genuinely elite alternatives (${bonusAgainstElitePool})`);
  assert.equal(bonusAgainstElitePool, 0, "a captain who doesn't come close to the pool's elite options should earn zero edge, not a self-referential positive one");
});

// --- Stability: near-tied inputs don't produce wild, unexplainable swings ---

test("stability: two near-identical GK pairs (tiny price/rotation differences) score within a small band of each other", () => {
  const primary = makePlayer({ id: 1, positionShort: "GKP", positionId: 1, price: 4.5, priorStarts: 20, priorMinutes: 1800, priorSaves: 50 });
  const backupA = makePlayer({ id: 2, positionShort: "GKP", positionId: 1, price: 4.1, priorStarts: 20, priorMinutes: 1800, priorSaves: 48 });
  const backupB = makePlayer({ id: 3, positionShort: "GKP", positionId: 1, price: 4.1, priorStarts: 20, priorMinutes: 1800, priorSaves: 49 });
  const weeksA = [1, 2, 3].map((eventId) => ({ eventId, xi: [], bench: [], captain: primary, vice: backupA, formation: "3-4-3", points: 0, captainPoints: 0, vicePoints: 0 } as WeekPlan));
  const weeksB = [1, 2, 3].map((eventId) => ({ eventId, xi: [], bench: [], captain: primary, vice: backupB, formation: "3-4-3", points: 0, captainPoints: 0, vicePoints: 0 } as WeekPlan));
  const termA = gkStructureTerm([primary, backupA], weeksA, [1, 1, 1], metricsFn, T);
  const termB = gkStructureTerm([primary, backupB], weeksB, [1, 1, 1], metricsFn, T);
  assert.ok(Math.abs(termA - termB) < 1, `near-identical rotation candidates should score within a small band of each other, got ${termA} vs ${termB}`);
});

test("stability: optimize() is deterministic -- same data produces the same squad every run (seeded RNG)", () => {
  const players: FplPlayer[] = [];
  let id = 1;
  for (let team = 1; team <= 20; team++) {
    players.push(makePlayer({ id: id++, positionShort: "GKP", positionId: 1, teamId: team, price: 4 + (team % 3) * 0.3 }));
    players.push(makePlayer({ id: id++, positionShort: "GKP", positionId: 1, teamId: team, price: 4 }));
    for (let i = 0; i < 5; i++) players.push(makePlayer({ id: id++, positionShort: "DEF", positionId: 2, teamId: team, price: 4 + i * 0.4, minutes: 900, expectedGoals: 0.1 * i }));
    for (let i = 0; i < 5; i++) players.push(makePlayer({ id: id++, positionShort: "MID", positionId: 3, teamId: team, price: 4.5 + i * 0.6, minutes: 900, expectedGoals: 0.15 * i, expectedAssists: 0.1 * i }));
    for (let i = 0; i < 3; i++) players.push(makePlayer({ id: id++, positionShort: "FWD", positionId: 4, teamId: team, price: 4.5 + i * 0.8, minutes: 900, expectedGoals: 0.3 * (i + 1) }));
  }
  const events = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: `GW${i + 1}`, deadline: new Date(Date.now() + (i + 1) * 86400000).toISOString(), current: false, next: i === 0, finished: false, dataChecked: false }));
  const data = makeData({ players, events });
  const runOnce = () => createOptimizer(data, "Balanced 5 GWs", "Balanced", "Maximum xPts").optimize().squad.map((p) => p.id).sort((a, b) => a - b);
  assert.deepEqual(runOnce(), runOnce(), "the same data must produce the same optimized squad every run");
});
