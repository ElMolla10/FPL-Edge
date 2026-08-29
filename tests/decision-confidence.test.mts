import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeDecisionConfidence,
  classifyDecisionConfidence,
  freezeDecisionPlan,
  playerEventOutcomeKey,
  sampleDecisionScenario,
  scoreDecisionPlanWeek,
} from "../app/lib/decision-confidence.ts";
import { buildPlayerEventOutcomeModel, samplePmf } from "../app/lib/projection-distribution.ts";
import { FplData, FplFixture, FplPlayer } from "../app/lib/fpl.ts";
import { createOptimizer } from "../app/lib/optimizer.ts";

type Position = FplPlayer["positionShort"];

function player(id: number, positionShort: Position, overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id, name: `P${id}`, firstName: `P${id}`, secondName: "", teamId: id, teamName: `Team ${id}`, teamShort: `T${id}`,
    positionId: positionShort === "GKP" ? 1 : positionShort === "DEF" ? 2 : positionShort === "MID" ? 3 : 4,
    position: positionShort, positionShort, price: 5, status: "a", chance: null,
    epNext: 0, form: 3, pointsPerGame: 3, priorPointsPerGame: 3, priorMinutes: 1800, priorStarts: 20,
    priorExpectedGoals: 2, priorExpectedAssists: 2, priorBonus: 8, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 100, totalPoints: 0, eventPoints: 0, eventMinutes: 0, selectedBy: 5,
    priceChange: 0, priceProjectionToday: 0, transfersIn: 0, transfersOut: 0, goals: 0, assists: 0,
    expectedGoals: 0, expectedAssists: 0, expectedGoalInvolvements: 0, expectedGoalsConceded: 0,
    cleanSheets: 0, goalsConceded: 0, minutes: 0, starts: 0, bonus: 0, bps: 0, ictIndex: 0,
    influence: 0, creativity: 0, threat: 0, saves: 0, penaltiesSaved: 0, defensiveContribution: 0,
    clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0, penaltiesOrder: null,
    directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
    ...overrides,
  };
}

function standardSquad(seed = 0): FplPlayer[] {
  return [
    player(seed + 1, "GKP"), player(seed + 2, "GKP"),
    ...Array.from({ length: 5 }, (_, index) => player(seed + 10 + index, "DEF")),
    ...Array.from({ length: 5 }, (_, index) => player(seed + 20 + index, "MID")),
    ...Array.from({ length: 3 }, (_, index) => player(seed + 30 + index, "FWD")),
  ];
}

function formation442(squad: FplPlayer[]) {
  const xi = [
    squad.find(p => p.positionShort === "GKP")!,
    ...squad.filter(p => p.positionShort === "DEF").slice(0, 4),
    ...squad.filter(p => p.positionShort === "MID").slice(0, 4),
    ...squad.filter(p => p.positionShort === "FWD").slice(0, 2),
  ];
  const bench = squad.filter(p => !xi.some(x => x.id === p.id));
  return { xi, bench };
}

type ModelOptions = {
  appeared?: number;
  reached60?: number;
  pointsPmf?: number[];
  fixtureId?: number;
  eventId?: number;
  cleanSheetProbability?: number;
  cleanSheetPoints?: number;
};

function model(p: FplPlayer, options: ModelOptions = {}) {
  const eventId = options.eventId ?? 1;
  const fixtureId = options.fixtureId ?? 100 + eventId;
  return {
    player: p,
    eventId,
    fixtures: [{
      fixtureId,
      teamId: p.teamId,
      appearanceProbability: options.appeared ?? 1,
      reached60Probability: options.reached60 ?? 1,
      pointsWhenAppearedPmf: options.pointsPmf ?? [1],
      cleanSheetProbability: options.cleanSheetProbability ?? 0,
      cleanSheetPoints: options.cleanSheetPoints ?? 0,
    }],
  };
}

function blankModel(p: FplPlayer, eventId = 1) {
  return { player: p, eventId, fixtures: [] };
}

function deterministicModels(players: FplPlayer[], overrides = new Map<number, ModelOptions>()) {
  return players.map(p => model(p, overrides.get(p.id)));
}

function frozenPlan(id: string, squad: FplPlayer[], captainMultiplier: 2 | 3 = 2) {
  const { xi, bench } = formation442(squad);
  return freezeDecisionPlan({
    id,
    weeks: [{ eventId: 1, xi, bench, captain: xi.at(-1)!, vice: xi.at(-2)!, captainMultiplier }],
  });
}

function swapPlayer(squad: FplPlayer[], outgoing: FplPlayer, incoming: FplPlayer) {
  return squad.map(p => p.id === outgoing.id ? incoming : p);
}

function compareOneChange(pointsPmf: number[], hit = 0, scenarioCount = 100) {
  const baselineSquad = standardSquad();
  const outgoing = baselineSquad.find(p => p.positionShort === "MID")!;
  const incoming = player(999, "MID");
  const candidateSquad = swapPlayer(baselineSquad, outgoing, incoming);
  const models = deterministicModels([...baselineSquad, incoming], new Map([[incoming.id, { pointsPmf }]]));
  return analyzeDecisionConfidence({
    baseline: frozenPlan("baseline", baselineSquad),
    candidate: frozenPlan("candidate", candidateSquad),
    playerEventModels: models,
    candidateAdditionalHitCost: hit,
    scenarioCount,
  });
}

test("a deterministic positive decision reports candidate preference and a 100% modeled scenario win rate", () => {
  const result = compareOneChange([0, 1]);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.deepEqual(result.frequencies, {
    gain: { count: 100, rate: 1 }, tie: { count: 0, rate: 0 }, loss: { count: 0, rate: 0 },
  });
  assert.equal(result.expectedDelta, 1);
  assert.deepEqual({ p10: result.p10, p50: result.p50, p90: result.p90 }, { p10: 1, p50: 1, p90: 1 });
  assert.equal(result.preferred, "candidate");
  assert.equal(result.preferredAlternativeScenarioWinRate, 1);
  assert.equal(result.label, "Robust");
});

test("a deterministic negative decision reports baseline preference using P(delta < 0)", () => {
  const baselineSquad = standardSquad();
  const outgoing = baselineSquad.find(p => p.positionShort === "MID")!;
  const incoming = player(999, "MID");
  const candidateSquad = swapPlayer(baselineSquad, outgoing, incoming);
  const models = deterministicModels([...baselineSquad, incoming], new Map([[outgoing.id, { pointsPmf: [0, 1] }]]));
  const result = analyzeDecisionConfidence({ baseline: frozenPlan("baseline", baselineSquad), candidate: frozenPlan("candidate", candidateSquad), playerEventModels: models, scenarioCount: 20, candidateAdditionalHitCost: 0 });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.expectedDelta, -1);
  assert.equal(result.frequencies.loss.rate, 1);
  assert.equal(result.preferred, "baseline");
  assert.equal(result.preferredAlternativeScenarioWinRate, 1);
  assert.equal(result.label, "Robust");
});

test("equal outcomes report a tie with no invented win rate and a Close call label", () => {
  const result = compareOneChange([1]);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.expectedDelta, 0);
  assert.equal(result.frequencies.tie.rate, 1);
  assert.equal(result.preferred, "tie");
  assert.equal(result.preferredAlternativeScenarioWinRate, null);
  assert.equal(result.label, "Close call");
});

test("an exact 50/50 gain-loss distribution remains an exact tie rather than rounding to a preference", () => {
  const baselineSquad = standardSquad();
  const outgoing = baselineSquad.find(p => p.positionShort === "MID")!;
  const incoming = player(999, "MID");
  const candidateSquad = swapPlayer(baselineSquad, outgoing, incoming);
  const overrides = new Map<number, ModelOptions>([
    [outgoing.id, { pointsPmf: [0, 1] }],
    [incoming.id, { pointsPmf: [.5, 0, .5] }],
  ]);
  const result = analyzeDecisionConfidence({ baseline: frozenPlan("baseline", baselineSquad), candidate: frozenPlan("candidate", candidateSquad), playerEventModels: deterministicModels([...baselineSquad, incoming], overrides), scenarioCount: 100, candidateAdditionalHitCost: 0 });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.frequencies.gain.count, 50);
  assert.equal(result.frequencies.loss.count, 50);
  assert.equal(result.expectedDelta, 0);
  assert.equal(result.preferred, "tie");
  assert.equal(result.preferredAlternativeScenarioWinRate, null);
});

test("identical inputs produce byte-identical decision results", () => {
  const first = compareOneChange([.2, .3, .3, .2], 0, 256);
  const second = compareOneChange([.2, .3, .3, .2], 0, 256);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("freezing a plan prevents later mutation of selected player metadata", () => {
  const squad = standardSquad();
  const plan = frozenPlan("immutable", squad);
  assert.throws(() => { (plan.weeks[0].xi[0] as FplPlayer).positionShort = "MID"; }, TypeError);
  assert.equal(plan.weeks[0].xi[0].positionShort, "GKP");
});

test("inverse-CDF sampling never selects a zero-probability outcome at the lower boundary", () => {
  assert.equal(samplePmf([0, 1], 0), 1);
});

test("an unchanged stochastic player's own points genuinely vary across scenarios yet cancel exactly out of the squad-level delta", () => {
  const baselineSquad = standardSquad();
  const outgoing = baselineSquad.find(p => p.positionShort === "MID")!;
  const incoming = player(999, "MID");
  const candidateSquad = swapPlayer(baselineSquad, outgoing, incoming);
  const { xi: baselineXi } = formation442(baselineSquad);
  const volatile = baselineXi.filter(p => p.positionShort === "FWD")[0]; // xi.at(-1) is the captain; this is the other forward.
  const overrides = new Map<number, ModelOptions>([
    [incoming.id, { pointsPmf: [0, 0, 0, 1] }], // deterministic: the only source of squad-level difference.
    [volatile.id, { pointsPmf: [.25, .25, .25, .25] }], // genuinely stochastic, unchanged between the two plans.
  ]);
  const models = deterministicModels([...baselineSquad, incoming], overrides);
  const scenarioCount = 128;

  // Precondition: the volatile player's own points must actually differ across scenarios, or
  // "cancels exactly" would be vacuously true because nothing ever varied to cancel.
  const volatileOutcomes = new Set<number>();
  for (let scenario = 0; scenario < scenarioCount; scenario++) {
    volatileOutcomes.add(sampleDecisionScenario(models, scenario, scenarioCount).get(playerEventOutcomeKey(1, volatile.id))!.points);
  }
  assert.equal(volatileOutcomes.size, 4, "the volatile player must take all four possible point values across scenarios, or this test is not exercising real cancellation");

  const result = analyzeDecisionConfidence({
    baseline: frozenPlan("baseline", baselineSquad),
    candidate: frozenPlan("candidate", candidateSquad),
    playerEventModels: models,
    scenarioCount,
    candidateAdditionalHitCost: 0,
  });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  // The squad-level delta is the SAME constant (+3, from the MID swap alone) in every one of the 128
  // scenarios despite the volatile forward's own points ranging over 4 different values -- proof the
  // shared outcomes map cancels an unchanged player exactly, not just on average.
  assert.deepEqual({ p10: result.p10, p50: result.p50, p90: result.p90 }, { p10: 3, p50: 3, p90: 3 });
  assert.equal(result.expectedDelta, 3);
  assert.deepEqual(result.frequencies, { gain: { count: 128, rate: 1 }, tie: { count: 0, rate: 0 }, loss: { count: 0, rate: 0 } });
});

test("a four-point hit reverses a deterministic three-point raw gain", () => {
  const result = compareOneChange([0, 0, 0, 1], 4);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.expectedDelta, -1);
  assert.equal(result.preferred, "baseline");
  assert.equal(result.frequencies.loss.rate, 1);
});

test("legal autosubs count the first eligible bench player", () => {
  const squad = standardSquad();
  const { xi, bench } = formation442(squad);
  const absent = xi.find(p => p.positionShort === "FWD")!;
  const firstBench = bench.find(p => p.positionShort !== "GKP")!;
  const overrides = new Map<number, ModelOptions>([[absent.id, { appeared: 0, reached60: 0 }], [firstBench.id, { pointsPmf: [0, 0, 0, 1] }]]);
  const outcomes = sampleDecisionScenario(deterministicModels(squad, overrides), 0, 8);
  const week = freezeDecisionPlan({ id: "autosub", weeks: [{ eventId: 1, xi, bench, captain: xi.at(-1)!, vice: xi.at(-2)!, captainMultiplier: 2 }] }).weeks[0];
  assert.equal(scoreDecisionPlanWeek(week, outcomes), 27);
});

test("a non-appearing player receives no points from scoring or clean-sheet factors", () => {
  const p = player(10, "DEF", { teamId: 7 });
  const highScoringPmf = new Array(13).fill(0);
  highScoringPmf[12] = 1;
  const outcomes = sampleDecisionScenario([model(p, { appeared: 0, reached60: 0, pointsPmf: highScoringPmf, cleanSheetProbability: 1, cleanSheetPoints: 4 })], 0, 16);
  assert.deepEqual(outcomes.get(playerEventOutcomeKey(1, p.id)), { appeared: false, reached60: false, points: 0 });
});

test("an illegal midfield substitution is skipped when a missing defender would break formation", () => {
  const squad = standardSquad();
  const gk = squad.filter(p => p.positionShort === "GKP");
  const defs = squad.filter(p => p.positionShort === "DEF");
  const mids = squad.filter(p => p.positionShort === "MID");
  const fwds = squad.filter(p => p.positionShort === "FWD");
  const xi = [gk[0], ...defs.slice(0, 3), ...mids.slice(0, 4), ...fwds];
  // In this 3-4-3, the fifth MID cannot replace a missing DEF (2-5-3), so the legal DEF behind
  // them must be used. No player is duplicated between the frozen XI and bench.
  const bench = [gk[1], mids[4], defs[3], defs[4]];
  const missingDef = defs[0];
  const overrides = new Map<number, ModelOptions>([
    [missingDef.id, { appeared: 0, reached60: 0 }],
    [mids[4].id, { pointsPmf: new Array(11).fill(0).map((_, i) => i === 10 ? 1 : 0) }],
    [defs[3].id, { pointsPmf: [0, 0, 0, 1] }],
  ]);
  const outcomes = sampleDecisionScenario(deterministicModels(squad, overrides), 0, 8);
  const week = freezeDecisionPlan({ id: "formation", weeks: [{ eventId: 1, xi, bench, captain: fwds[0], vice: fwds[1], captainMultiplier: 2 }] }).weeks[0];
  assert.equal(scoreDecisionPlanWeek(week, outcomes), 27, "the 5-point defender replaces the missing defender; the 12-point midfielder must remain benched");
});

test("a playing reserve goalkeeper replaces a zero-appearance starting goalkeeper", () => {
  const squad = standardSquad();
  const { xi, bench } = formation442(squad);
  const startingGk = xi.find(p => p.positionShort === "GKP")!;
  const reserveGk = bench.find(p => p.positionShort === "GKP")!;
  const overrides = new Map<number, ModelOptions>([[startingGk.id, { appeared: 0, reached60: 0 }], [reserveGk.id, { pointsPmf: [0, 0, 0, 0, 1] }]]);
  const outcomes = sampleDecisionScenario(deterministicModels(squad, overrides), 0, 8);
  const week = freezeDecisionPlan({ id: "gk", weeks: [{ eventId: 1, xi, bench, captain: xi.at(-1)!, vice: xi.at(-2)!, captainMultiplier: 2 }] }).weeks[0];
  assert.equal(scoreDecisionPlanWeek(week, outcomes), 28);
});

test("captaincy passes to the vice at the frozen multiplier when the captain does not appear", () => {
  const squad = standardSquad();
  const { xi, bench } = formation442(squad);
  const captain = xi.at(-1)!;
  const vice = xi.at(-2)!;
  const overrides = new Map<number, ModelOptions>([
    [captain.id, { appeared: 0, reached60: 0 }],
    [vice.id, { pointsPmf: [0, 0, 0, 1] }],
    ...bench.map(p => [p.id, { appeared: 0, reached60: 0 }] as [number, ModelOptions]),
  ]);
  const outcomes = sampleDecisionScenario(deterministicModels(squad, overrides), 0, 8);
  const week = freezeDecisionPlan({ id: "vice", weeks: [{ eventId: 1, xi, bench, captain, vice, captainMultiplier: 3 }] }).weeks[0];
  assert.equal(scoreDecisionPlanWeek(week, outcomes), 33, "the vice's 5 points receive the two extra Triple Captain copies");
});

test("no captain multiplier is invented when both frozen captain and vice fail to appear", () => {
  const squad = standardSquad();
  const { xi, bench } = formation442(squad);
  const captain = xi.at(-1)!;
  const vice = xi.at(-2)!;
  const overrides = new Map<number, ModelOptions>([
    [captain.id, { appeared: 0, reached60: 0 }],
    [vice.id, { appeared: 0, reached60: 0 }],
    ...bench.map(p => [p.id, { appeared: 0, reached60: 0 }] as [number, ModelOptions]),
  ]);
  const outcomes = sampleDecisionScenario(deterministicModels(squad, overrides), 0, 8);
  const week = freezeDecisionPlan({ id: "lost-captaincy", weeks: [{ eventId: 1, xi, bench, captain, vice, captainMultiplier: 3 }] }).weeks[0];
  assert.equal(scoreDecisionPlanWeek(week, outcomes), 18, "only the nine playing starters count once");
});

test("a bench-only transfer changes points only through an autosub", () => {
  const baselineSquad = standardSquad();
  const { xi, bench } = formation442(baselineSquad);
  const absent = xi.find(p => p.positionShort === "FWD")!;
  const outgoingBench = bench.find(p => p.positionShort === "DEF")!;
  const incomingBench = player(999, "DEF");
  const candidateBench = bench.map(p => p.id === outgoingBench.id ? incomingBench : p);
  const baseline = freezeDecisionPlan({ id: "baseline", weeks: [{ eventId: 1, xi, bench, captain: xi.at(-1)!, vice: xi.at(-2)!, captainMultiplier: 2 }] });
  const candidate = freezeDecisionPlan({ id: "candidate", weeks: [{ eventId: 1, xi, bench: candidateBench, captain: xi.at(-1)!, vice: xi.at(-2)!, captainMultiplier: 2 }] });
  const noAutosub = analyzeDecisionConfidence({ baseline, candidate, playerEventModels: deterministicModels([...baselineSquad, incomingBench], new Map([[incomingBench.id, { pointsPmf: [0, 0, 0, 1] }]])), scenarioCount: 32, candidateAdditionalHitCost: 0 });
  assert.equal(noAutosub.status, "available");
  if (noAutosub.status !== "available") return;
  assert.equal(noAutosub.expectedDelta, 0, "a stronger bench player has no direct value when every frozen starter appears");
  const overrides = new Map<number, ModelOptions>([[absent.id, { appeared: 0, reached60: 0 }], [incomingBench.id, { pointsPmf: [0, 0, 0, 1] }]]);
  const result = analyzeDecisionConfidence({ baseline, candidate, playerEventModels: deterministicModels([...baselineSquad, incomingBench], overrides), scenarioCount: 32, candidateAdditionalHitCost: 0 });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.expectedDelta, 3);
});

test("same-team defenders share one clean-sheet factor for a fixture", () => {
  const first = player(10, "DEF", { teamId: 7 });
  const second = player(11, "DEF", { teamId: 7 });
  const models = [first, second].map(p => model(p, { fixtureId: 501, cleanSheetProbability: .5, cleanSheetPoints: 4 }));
  const observed = new Set<number>();
  for (let scenario = 0; scenario < 64; scenario++) {
    const outcomes = sampleDecisionScenario(models, scenario, 64);
    const a = outcomes.get(playerEventOutcomeKey(1, first.id))!;
    const b = outcomes.get(playerEventOutcomeKey(1, second.id))!;
    assert.equal(a.points, b.points, `scenario ${scenario} must not give only one teammate the shared clean sheet`);
    observed.add(a.points);
  }
  assert.deepEqual([...observed].sort((a, b) => a - b), [2, 6], "the shared factor must generate both clean-sheet and no-clean-sheet scenarios");
});

test("blank events produce no appearance while double gameweeks sum both fixture outcomes", () => {
  const p = player(30, "FWD");
  const blank = sampleDecisionScenario([blankModel(p)], 0, 16).get(playerEventOutcomeKey(1, p.id))!;
  assert.deepEqual(blank, { appeared: false, reached60: false, points: 0 });
  const double = {
    player: p,
    eventId: 2,
    fixtures: [
      { ...model(p, { eventId: 2, fixtureId: 201, pointsPmf: [0, 1] }).fixtures[0] },
      { ...model(p, { eventId: 2, fixtureId: 202, pointsPmf: [0, 1] }).fixtures[0] },
    ],
  };
  const outcome = sampleDecisionScenario([double], 0, 16).get(playerEventOutcomeKey(2, p.id))!;
  assert.deepEqual(outcome, { appeared: true, reached60: true, points: 6 });
});

test("the real projection adapter preserves fixture IDs for doubles and emits an empty blank model", () => {
  const p = player(1, "DEF", { teamId: 1 });
  const fixtures: FplFixture[] = [
    { id: 101, event: 1, teamH: 1, teamA: 2, teamHDifficulty: 3, teamADifficulty: 3, finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null },
    { id: 102, event: 1, teamH: 3, teamA: 1, teamHDifficulty: 3, teamADifficulty: 3, finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null },
  ];
  assert.deepEqual(buildPlayerEventOutcomeModel(p, 1, fixtures, 1).fixtures.map(fixture => fixture.fixtureId), [101, 102]);
  assert.deepEqual(buildPlayerEventOutcomeModel(p, 2, fixtures, 1).fixtures, []);
});

test("zero future events returns unavailable without confidence, quantiles or a label", () => {
  const empty = freezeDecisionPlan({ id: "empty", weeks: [] });
  const result = analyzeDecisionConfidence({ baseline: empty, candidate: empty, playerEventModels: [], scenarioCount: 64, candidateAdditionalHitCost: 0 });
  assert.deepEqual(result, { status: "unavailable", reason: "No shared future events are available for decision analysis." });
  assert.ok(!("label" in result));
  assert.ok(!("p10" in result));
  assert.ok(!("preferredAlternativeScenarioWinRate" in result));
});

test("classification exhaustively follows preferred-advantage P10 and P25-P75 rules", () => {
  const cases = [
    { deltas: [1, 1, 1, 1], expected: 1, label: "Robust" },
    { deltas: [-1, -1, -1, -1], expected: -1, label: "Robust" },
    { deltas: [-1, -1, 1, 1], expected: 0, label: "Close call" },
    { deltas: [...new Array(3).fill(-1), ...new Array(7).fill(1)], expected: .4, label: "Close call" },
    { deltas: [...new Array(20).fill(-1), ...new Array(80).fill(1)], expected: .6, label: "High-risk" },
    { deltas: [...new Array(20).fill(1), ...new Array(80).fill(-1)], expected: -.6, label: "High-risk" },
  ] as const;
  for (const entry of cases) assert.equal(classifyDecisionConfidence(entry.deltas, entry.expected), entry.label, JSON.stringify(entry));
});

// GUARD: freezeDecisionPlan always copies each player via {...player} before Object.freeze-ing the
// copy, never the original -- so nothing in this engine, however it evolves, can reach back into the
// squad array or player objects the optimizer holds. This does not by itself prove the two systems
// are decoupled in some general sense; it guards the one specific invariant (copy-before-freeze) that
// actually prevents cross-contamination. Same GUARD/GAP labeling discipline as validateSquadEvaluation.
test("freezeDecisionPlan copies player objects before freezing, so shadow analysis cannot mutate the squad it was built from", () => {
  const squad = standardSquad();
  const events = [{ id: 1, name: "Gameweek 1", deadline: "2099-01-01T00:00:00.000Z", current: false, next: true, finished: false, dataChecked: false }];
  const data: FplData = {
    updatedAt: "2098-12-01T00:00:00.000Z", source: "test", seasonStatsThrough: 0, players: squad,
    fixtures: [], events, teams: squad.map(p => ({ id: p.teamId, name: p.teamName, short: p.teamShort })),
    rules: { budget: 100, squadSize: 15, teamLimit: 3, positions: [
      { id: 1, name: "Goalkeeper", short: "GKP", squad: 2, minPlay: 1, maxPlay: 1 },
      { id: 2, name: "Defender", short: "DEF", squad: 5, minPlay: 3, maxPlay: 5 },
      { id: 3, name: "Midfielder", short: "MID", squad: 5, minPlay: 2, maxPlay: 5 },
      { id: 4, name: "Forward", short: "FWD", squad: 3, minPlay: 1, maxPlay: 3 },
    ] },
  };
  const optimizer = createOptimizer(data, "Balanced 5 GWs", "Balanced", "Maximum xPts");
  const before = optimizer.evaluate(squad);
  const plan = freezeDecisionPlan({ id: "shadow", weeks: before.weeks.map(week => ({ ...week, captainMultiplier: 2 as const })) });
  analyzeDecisionConfidence({ baseline: plan, candidate: plan, playerEventModels: squad.map(p => blankModel(p)), scenarioCount: 32, candidateAdditionalHitCost: 0 });
  const after = optimizer.evaluate(squad);
  assert.deepEqual(after.scores, before.scores);
  assert.deepEqual(after, before);
});
