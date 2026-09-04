import assert from "node:assert/strict";
import test from "node:test";
import { FplFixture, FplPlayer, liveScoringMovers, playerProjection } from "../app/lib/fpl.ts";

const EVENT_ID = 10;
const FIRST_EVENT = 10;

function makePlayer(id: number, name: string, eventPoints: number, overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id, name, firstName: name, secondName: "", teamId: id, teamName: `Team ${id}`, teamShort: `T${id}`,
    positionId: 3, position: "Midfielder", positionShort: "MID", price: 6, status: "a", chance: null,
    epNext: 0, form: 4, pointsPerGame: 4, priorPointsPerGame: 4, priorMinutes: 1800, priorStarts: 20,
    priorExpectedGoals: 2, priorExpectedAssists: 2, priorBonus: 5, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 0, totalPoints: 0, eventPoints, eventMinutes: 90, eventBonus: 0, eventDefensiveContribution: 0,
    selectedBy: 10, priceChange: 0, priceProjectionToday: 0, priceChangeSinceStart: 0, priceOutlook: [], transfersIn: 0, transfersOut: 0, goals: 0, assists: 0,
    expectedGoals: 0, expectedAssists: 0, expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0,
    goalsConceded: 0, minutes: 900, starts: 10, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0,
    saves: 0, penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
    ...overrides,
  };
}

function fixture(teamId: number, started: boolean): FplFixture {
  return { id: teamId, event: EVENT_ID, teamH: teamId, teamA: 999, teamHDifficulty: 3, teamADifficulty: 3, finished: false, kickoff: null, started, teamHScore: null, teamAScore: null };
}

test("liveScoringMovers: a player who outscored their own projection is classified as helping, and vice versa for hurting", () => {
  const overperformer = makePlayer(1, "Overperformer", 20);
  const underperformer = makePlayer(2, "Underperformer", 0);
  const fixtures = [fixture(1, true), fixture(2, true)];
  const { hurting, helping } = liveScoringMovers([overperformer, underperformer], null, 1, EVENT_ID, fixtures, FIRST_EVENT);
  assert.equal(helping.length, 1);
  assert.equal(helping[0].player.id, 1);
  assert.ok(helping[0].delta > 0, "an overperformer's delta must be positive");
  assert.equal(hurting.length, 1);
  assert.equal(hurting[0].player.id, 2);
  assert.ok(hurting[0].delta < 0, "an underperformer's delta must be negative");
});

test("liveScoringMovers: excludes a player whose fixture hasn't started, even with a huge raw points/projection gap", () => {
  const notStarted = makePlayer(1, "NotKickedOff", 0);
  const fixtures = [fixture(1, false)];
  const { hurting, helping } = liveScoringMovers([notStarted], null, 1, EVENT_ID, fixtures, FIRST_EVENT);
  assert.deepEqual(hurting, []);
  assert.deepEqual(helping, []);
});

test("liveScoringMovers: the captain's multiplier is applied to BOTH the actual and projected sides of the delta", () => {
  const captain = makePlayer(1, "Captain", 20);
  const nonCaptain = makePlayer(2, "NonCaptain", 20);
  const fixtures = [fixture(1, true), fixture(2, true)];
  const { helping } = liveScoringMovers([captain, nonCaptain], 1, 2, EVENT_ID, fixtures, FIRST_EVENT);
  const captainMover = helping.find(m => m.player.id === 1)!;
  const nonCaptainMover = helping.find(m => m.player.id === 2)!;
  // Identical raw eventPoints and identical underlying projection (same stat inputs) -- captain's
  // multiplier of 2 must exactly double both countedActual, countedProjected, and therefore delta.
  assert.equal(captainMover.countedActual, nonCaptainMover.countedActual * 2);
  assert.equal(captainMover.countedProjected, nonCaptainMover.countedProjected * 2);
  assert.equal(captainMover.delta, nonCaptainMover.delta * 2);
});

test("liveScoringMovers: caps each direction at 3, sorted by magnitude of delta (biggest movers first)", () => {
  const helpers = [10, 40, 30, 20, 5].map((points, i) => makePlayer(i + 1, `H${i + 1}`, points));
  const hurters = [1, 2, 3, 4, 5].map((id, i) => makePlayer(id + 100, `U${i + 1}`, 0, { priceProjectionToday: 0 }));
  // Give hurters distinct, decreasing projections by varying priorMinutes/starts so their delta
  // magnitudes differ (all score 0, but their projected xPts -- and therefore |delta| -- differ).
  const distinctHurters = hurters.map((p, i) => ({ ...p, priorMinutes: 200 + i * 400, priorStarts: 2 + i * 4, minutes: 200 + i * 400, starts: 2 + i * 4 }));
  const all = [...helpers, ...distinctHurters];
  const fixtures = all.map(p => fixture(p.teamId, true));
  const { hurting, helping } = liveScoringMovers(all, null, 1, EVENT_ID, fixtures, FIRST_EVENT);
  assert.equal(helping.length, 3, "helping list must be capped at 3");
  assert.equal(hurting.length, 3, "hurting list must be capped at 3");
  for (let i = 0; i < helping.length - 1; i++) assert.ok(helping[i].delta >= helping[i + 1].delta, "helping must be sorted with the biggest positive delta first");
  for (let i = 0; i < hurting.length - 1; i++) assert.ok(hurting[i].delta <= hurting[i + 1].delta, "hurting must be sorted with the most negative delta first");
});

test("liveScoringMovers: a player exactly matching their own projection (delta === 0) appears in neither list", () => {
  const player = makePlayer(1, "OnTarget", 0);
  const fixtures = [fixture(1, true)];
  const projected = playerProjection(player, EVENT_ID, fixtures, FIRST_EVENT);
  const exact = { ...player, eventPoints: projected };
  const { hurting, helping } = liveScoringMovers([exact], null, 1, EVENT_ID, fixtures, FIRST_EVENT);
  assert.deepEqual(hurting, []);
  assert.deepEqual(helping, []);
});
