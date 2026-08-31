import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTransferDecisionConfidence, prepareTransferDecisionConfidence } from "../app/lib/transfer-confidence.ts";
import { createOptimizer } from "../app/lib/optimizer.ts";
import { FplData, FplFixture, FplPlayer } from "../app/lib/fpl.ts";

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

function standardSquad(): FplPlayer[] {
  return [
    player(1, "GKP"), player(2, "GKP"),
    ...Array.from({ length: 5 }, (_, i) => player(10 + i, "DEF")),
    ...Array.from({ length: 5 }, (_, i) => player(20 + i, "MID")),
    ...Array.from({ length: 3 }, (_, i) => player(30 + i, "FWD")),
  ];
}

const EVENT_IDS = [1, 2, 3, 4, 5];

function fixturesFor(teamIds: number[]): FplFixture[] {
  return EVENT_IDS.flatMap(eventId => teamIds.map((teamId): FplFixture => ({
    id: eventId * 10000 + teamId, event: eventId, teamH: teamId, teamA: teamId + 90000,
    teamHDifficulty: 3, teamADifficulty: 3, finished: false, kickoff: null, started: false,
    teamHScore: null, teamAScore: null,
  })));
}

function makeData(squad: FplPlayer[], extraTeamIds: number[] = []): FplData {
  const events = EVENT_IDS.map(id => ({ id, name: `Gameweek ${id}`, deadline: "2099-01-01T00:00:00.000Z", current: false, next: id === EVENT_IDS[0], finished: false, dataChecked: false }));
  return {
    updatedAt: "2098-12-01T00:00:00.000Z", source: "test", seasonStatsThrough: 0, players: squad,
    fixtures: fixturesFor([...squad.map(p => p.teamId), ...extraTeamIds]), events,
    teams: squad.map(p => ({ id: p.teamId, name: p.teamName, short: p.teamShort })),
    rules: { budget: 100, squadSize: 15, teamLimit: 3, positions: [
      { id: 1, name: "Goalkeeper", short: "GKP", squad: 2, minPlay: 1, maxPlay: 1 },
      { id: 2, name: "Defender", short: "DEF", squad: 5, minPlay: 3, maxPlay: 5 },
      { id: 3, name: "Midfielder", short: "MID", squad: 5, minPlay: 2, maxPlay: 5 },
      { id: 4, name: "Forward", short: "FWD", squad: 3, minPlay: 1, maxPlay: 3 },
    ] },
  };
}

function weakOutgoingAndStrongIncoming() {
  const squad = standardSquad();
  const outgoing = squad.find(p => p.positionShort === "MID")!;
  Object.assign(outgoing, { priorMinutes: 400, priorStarts: 3, priorExpectedGoals: .2, priorExpectedAssists: .1, form: .5, pointsPerGame: 1, priorPointsPerGame: 1 });
  const incoming = player(999, "MID", { priorMinutes: 3000, priorStarts: 34, priorExpectedGoals: 14, priorExpectedAssists: 10, form: 8, pointsPerGame: 8, priorPointsPerGame: 8, price: 9 });
  return { squad, outgoing, incoming };
}

test("a strictly stronger deterministic swap reports candidate preference with a positive expected delta", () => {
  const { squad, outgoing, incoming } = weakOutgoingAndStrongIncoming();
  const data = makeData(squad, [incoming.teamId]);
  const optimizer = createOptimizer(data, "Balanced 5 GWs", "Balanced", "Maximum xPts");
  const result = analyzeTransferDecisionConfidence({ fixtures: data.fixtures, futureEventIds: optimizer.eventIds, squad, transfer: { out: outgoing, incoming, hitCost: 0 }, evaluate: optimizer.evaluate });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.preferred, "candidate");
  assert.ok(result.expectedDelta > 0, `expected a positive expectedDelta for a strictly stronger swap, got ${result.expectedDelta}`);
});

test("the transfer's own hit cost is passed through as the candidate's additional hit cost, and a large enough hit reverses an otherwise-positive swap", () => {
  const { squad, outgoing, incoming } = weakOutgoingAndStrongIncoming();
  const data = makeData(squad, [incoming.teamId]);
  const optimizer = createOptimizer(data, "Balanced 5 GWs", "Balanced", "Maximum xPts");
  const noHit = analyzeTransferDecisionConfidence({ fixtures: data.fixtures, futureEventIds: optimizer.eventIds, squad, transfer: { out: outgoing, incoming, hitCost: 0 }, evaluate: optimizer.evaluate });
  const hugeHit = analyzeTransferDecisionConfidence({ fixtures: data.fixtures, futureEventIds: optimizer.eventIds, squad, transfer: { out: outgoing, incoming, hitCost: 10000 }, evaluate: optimizer.evaluate });
  assert.equal(noHit.status, "available");
  assert.equal(hugeHit.status, "available");
  if (noHit.status !== "available" || hugeHit.status !== "available") return;
  assert.equal(noHit.preferred, "candidate");
  assert.equal(hugeHit.preferred, "baseline", "a hit cost far larger than any plausible points gain must reverse the preference to baseline");
  assert.ok(noHit.assumptions.some(assumption => assumption.includes("modeled scenario win rate") && assumption.includes("not calibrated probabilities")));
});

test("prepared primary transfer input retains the row's real hit cost and exact five-event optimizer horizon", () => {
  const { squad, outgoing, incoming } = weakOutgoingAndStrongIncoming();
  const data = makeData(squad, [incoming.teamId]);
  const optimizer = createOptimizer(data, "Balanced 5 GWs", "Balanced", "Maximum xPts");
  const prepared = prepareTransferDecisionConfidence({
    fixtures: data.fixtures, futureEventIds: optimizer.eventIds, dataUpdatedAt: data.updatedAt, squad,
    transfer: { out: outgoing, incoming, hitCost: 4 }, evaluate: optimizer.evaluate, scenarioCount: 1024,
  });
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") return;
  assert.equal(prepared.analysis.candidateAdditionalHitCost, 4);
  assert.equal(prepared.analysis.scenarioCount, 1024);
  assert.deepEqual(prepared.analysis.baseline.weeks.map(week => week.eventId), optimizer.eventIds);
  assert.deepEqual(prepared.analysis.candidate.weeks.map(week => week.eventId), optimizer.eventIds);
});

test("identical inputs produce byte-identical results", () => {
  const { squad, outgoing, incoming } = weakOutgoingAndStrongIncoming();
  const data = makeData(squad, [incoming.teamId]);
  const optimizer = createOptimizer(data, "Balanced 5 GWs", "Balanced", "Maximum xPts");
  const input = { fixtures: data.fixtures, futureEventIds: optimizer.eventIds, squad, transfer: { out: outgoing, incoming, hitCost: 0 }, evaluate: optimizer.evaluate, scenarioCount: 128 };
  const first = analyzeTransferDecisionConfidence(input);
  const second = analyzeTransferDecisionConfidence(input);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("zero future events returns unavailable before an evaluate stub that would throw can be called", () => {
  const squad = standardSquad();
  const outgoing = squad.find(p => p.positionShort === "MID")!;
  const incoming = player(999, "MID");
  let evaluateCalls = 0;
  const result = analyzeTransferDecisionConfidence({
    fixtures: [], futureEventIds: [], squad, transfer: { out: outgoing, incoming, hitCost: 0 },
    evaluate: () => { evaluateCalls++; throw new Error("evaluate must not be called"); },
  });
  assert.deepEqual(result, { status: "unavailable", reason: "No future events are available for transfer decision analysis." });
  assert.equal(evaluateCalls, 0);
});

test("analyzing a transfer does not mutate the squad array or its player objects passed in", () => {
  const { squad, outgoing, incoming } = weakOutgoingAndStrongIncoming();
  const data = makeData(squad, [incoming.teamId]);
  const optimizer = createOptimizer(data, "Balanced 5 GWs", "Balanced", "Maximum xPts");
  const squadSnapshot = squad.map(p => ({ ...p }));
  analyzeTransferDecisionConfidence({ fixtures: data.fixtures, futureEventIds: optimizer.eventIds, squad, transfer: { out: outgoing, incoming, hitCost: 0 }, evaluate: optimizer.evaluate });
  assert.deepEqual(squad, squadSnapshot);
});

test("invalid transfer identities and positions return unavailable before evaluation", () => {
  const squad = standardSquad();
  const outgoing = squad.find(p => p.positionShort === "MID")!;
  const incoming = player(999, "MID");
  let evaluateCalls = 0;
  const evaluate = (): never => { evaluateCalls++; throw new Error("invalid input must not evaluate"); };
  const common = { fixtures: [], futureEventIds: [1], evaluate };
  const cases = [
    { squad, transfer: { out: player(404, "MID"), incoming, hitCost: 0 }, reason: "Outgoing player 404 must exist exactly once in the squad." },
    { squad: [...squad, outgoing], transfer: { out: outgoing, incoming, hitCost: 0 }, reason: `Outgoing player ${outgoing.id} must exist exactly once in the squad.` },
    { squad, transfer: { out: outgoing, incoming: squad.find(p => p.positionShort === "MID" && p.id !== outgoing.id)!, hitCost: 0 }, reason: "Incoming player is already owned." },
    { squad, transfer: { out: outgoing, incoming: player(998, "FWD"), hitCost: 0 }, reason: "Outgoing and incoming player positions must match." },
  ];
  for (const entry of cases) {
    const result = analyzeTransferDecisionConfidence({ ...common, squad: entry.squad, transfer: entry.transfer });
    assert.deepEqual(result, { status: "unavailable", reason: entry.reason });
  }
  assert.equal(evaluateCalls, 0);
});

test("invalid horizon, hit cost and scenario count return unavailable before evaluation", () => {
  const { squad, outgoing, incoming } = weakOutgoingAndStrongIncoming();
  let evaluateCalls = 0;
  const evaluate = (): never => { evaluateCalls++; throw new Error("invalid input must not evaluate"); };
  const base = { fixtures: [], squad, transfer: { out: outgoing, incoming, hitCost: 0 }, evaluate };
  assert.equal(analyzeTransferDecisionConfidence({ ...base, futureEventIds: [1, 1] }).status, "unavailable");
  assert.equal(analyzeTransferDecisionConfidence({ ...base, futureEventIds: [Number.NaN] }).status, "unavailable");
  assert.equal(analyzeTransferDecisionConfidence({ ...base, futureEventIds: [1], transfer: { out: outgoing, incoming, hitCost: Number.NaN } }).status, "unavailable");
  assert.equal(analyzeTransferDecisionConfidence({ ...base, futureEventIds: [1], scenarioCount: 0 }).status, "unavailable");
  assert.equal(evaluateCalls, 0);
});

test("baseline and candidate evaluations must cover the explicit identical event horizon", () => {
  const { squad, outgoing, incoming } = weakOutgoingAndStrongIncoming();
  const data = makeData(squad, [incoming.teamId]);
  const optimizer = createOptimizer(data, "Balanced 5 GWs", "Balanced", "Maximum xPts");
  const valid = optimizer.evaluate(squad);
  let calls = 0;
  const evaluate = () => calls++ === 0 ? valid : { ...valid, weeks: valid.weeks.slice(1) };
  const result = analyzeTransferDecisionConfidence({ fixtures: data.fixtures, futureEventIds: optimizer.eventIds, squad, transfer: { out: outgoing, incoming, hitCost: 0 }, evaluate });
  assert.deepEqual(result, { status: "unavailable", reason: "Baseline and candidate evaluations do not cover the explicit future event horizon." });
});

test("arbitrary optimizer errors are not caught or converted into unavailable", () => {
  const { squad, outgoing, incoming } = weakOutgoingAndStrongIncoming();
  assert.throws(() => analyzeTransferDecisionConfidence({
    fixtures: [], futureEventIds: [1], squad, transfer: { out: outgoing, incoming, hitCost: 0 },
    evaluate: () => { throw new Error("optimizer exploded"); },
  }), /optimizer exploded/);
});
