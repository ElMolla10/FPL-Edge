import assert from "node:assert/strict";
import test from "node:test";
import { clubLineupCandidates, LINEUP_POSITIONS } from "../app/lib/lineup-intelligence.ts";
import type { FplFixture, FplPlayer } from "../app/lib/fpl.ts";

const EVENT_ID = 5;
const FIRST_EVENT = 5;
const fixtures: FplFixture[] = [];

// With priorMinutes:0, starts:0, scoutRisks:[], chance:null, status:"a", projectionMetrics'
// startProbability collapses to exactly clamp(.42+selectedBy/100,.35,.82) -- hand-verified below --
// which gives fully predictable, exact startProbability values to assert against, not just relative
// ordering.
function makePlayer(id: number, name: string, teamId: number, positionShort: string, selectedBy: number): FplPlayer {
  return {
    id, name, firstName: name, secondName: "", teamId, teamName: `Team ${teamId}`, teamShort: `T${teamId}`,
    positionId: positionShort === "GKP" ? 1 : positionShort === "DEF" ? 2 : positionShort === "MID" ? 3 : 4,
    position: positionShort, positionShort, price: 6, status: "a", chance: null,
    epNext: 0, form: 0, pointsPerGame: 0, priorPointsPerGame: 0, priorMinutes: 0, priorStarts: 0,
    priorExpectedGoals: 0, priorExpectedAssists: 0, priorBonus: 0, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 0, totalPoints: 0, eventPoints: 0, eventMinutes: 0, eventBonus: 0, eventDefensiveContribution: 0,
    selectedBy, priceChange: 0, priceProjectionToday: 0, transfersIn: 0, transfersOut: 0, goals: 0, assists: 0,
    expectedGoals: 0, expectedAssists: 0, expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0,
    goalsConceded: 0, minutes: 0, starts: 0, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0,
    saves: 0, penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
  };
}

test("clubLineupCandidates: real startProbability formula collapses exactly as hand-derived for these fixtures", () => {
  const player = makePlayer(1, "A", 1, "MID", 10);
  const candidates = clubLineupCandidates([player], 1, EVENT_ID, fixtures, FIRST_EVENT);
  // clamp(.42 + 10/100, .35, .82) = .52
  assert.equal(candidates.MID[0].startProbability, .52);
});

test("clubLineupCandidates: ranks real teammates within a position by startProbability descending", () => {
  const players = [
    makePlayer(1, "Low", 1, "MID", 5),   // .47
    makePlayer(2, "High", 1, "MID", 20), // .62
    makePlayer(3, "Mid", 1, "MID", 12),  // .54
  ];
  const candidates = clubLineupCandidates(players, 1, EVENT_ID, fixtures, FIRST_EVENT);
  assert.deepEqual(candidates.MID.map(c => c.player.name), ["High", "Mid", "Low"]);
});

test("clubLineupCandidates: never mixes players from a different real club", () => {
  const players = [
    makePlayer(1, "HomeClub", 1, "MID", 20),
    makePlayer(2, "OtherClub", 2, "MID", 30),
  ];
  const candidates = clubLineupCandidates(players, 1, EVENT_ID, fixtures, FIRST_EVENT);
  assert.deepEqual(candidates.MID.map(c => c.player.name), ["HomeClub"]);
});

test("clubLineupCandidates: never mixes a different real position into the wrong bucket", () => {
  const players = [
    makePlayer(1, "Midfielder", 1, "MID", 20),
    makePlayer(2, "Defender", 1, "DEF", 30),
  ];
  const candidates = clubLineupCandidates(players, 1, EVENT_ID, fixtures, FIRST_EVENT);
  assert.deepEqual(candidates.MID.map(c => c.player.name), ["Midfielder"]);
  assert.deepEqual(candidates.DEF.map(c => c.player.name), ["Defender"]);
});

test("clubLineupCandidates: the top-ranked player's competitionGap is their real lead over the next-best teammate", () => {
  const players = [
    makePlayer(1, "Top", 1, "FWD", 20),   // .62
    makePlayer(2, "Second", 1, "FWD", 12), // .54
  ];
  const candidates = clubLineupCandidates(players, 1, EVENT_ID, fixtures, FIRST_EVENT);
  const top = candidates.FWD.find(c => c.player.name === "Top")!;
  assert.ok(Math.abs(top.competitionGap - .08) < 1e-9, `expected +.08 lead, got ${top.competitionGap}`);
  assert.equal(top.closestCompetitorName, "Second");
});

test("clubLineupCandidates: a non-top player's competitionGap is a real, negative deficit versus the club's top option (not the nearest neighbour)", () => {
  const players = [
    makePlayer(1, "Top", 1, "DEF", 30),   // .72
    makePlayer(2, "Middle", 1, "DEF", 20), // .62
    makePlayer(3, "Bottom", 1, "DEF", 5),  // .47
  ];
  const candidates = clubLineupCandidates(players, 1, EVENT_ID, fixtures, FIRST_EVENT);
  const bottom = candidates.DEF.find(c => c.player.name === "Bottom")!;
  // Must compare against "Top" (.72), not "Middle" (.62) -- the club's real top option, not the
  // ranking-adjacent neighbour.
  assert.ok(Math.abs(bottom.competitionGap - (-.25)) < 1e-9, `expected -.25 deficit vs the top option, got ${bottom.competitionGap}`);
  assert.equal(bottom.closestCompetitorName, "Top");
});

test("clubLineupCandidates: a lone player at a position with no real teammate gets a null competitor and zero gap, not a fabricated tie", () => {
  const players = [makePlayer(1, "OnlyOne", 1, "GKP", 40)];
  const candidates = clubLineupCandidates(players, 1, EVENT_ID, fixtures, FIRST_EVENT);
  assert.equal(candidates.GKP[0].competitionGap, 0);
  assert.equal(candidates.GKP[0].closestCompetitorName, null);
});

test("clubLineupCandidates: caps each position at the top 5 by startProbability, not an arbitrary or unbounded list", () => {
  const players = Array.from({ length: 8 }, (_, i) => makePlayer(i + 1, `P${i + 1}`, 1, "MID", i * 3));
  const candidates = clubLineupCandidates(players, 1, EVENT_ID, fixtures, FIRST_EVENT);
  assert.equal(candidates.MID.length, 5);
  // The 5 kept must be the 5 real highest-selectedBy (and therefore highest-startProbability) players.
  assert.deepEqual(candidates.MID.map(c => c.player.name), ["P8", "P7", "P6", "P5", "P4"]);
});

test("clubLineupCandidates: returns all four real FPL position categories, never a fabricated formation shape or count", () => {
  const players = [makePlayer(1, "Keeper", 1, "GKP", 20)];
  const candidates = clubLineupCandidates(players, 1, EVENT_ID, fixtures, FIRST_EVENT);
  assert.deepEqual(Object.keys(candidates).sort(), [...LINEUP_POSITIONS].sort());
  assert.deepEqual(candidates.DEF, []);
  assert.deepEqual(candidates.MID, []);
  assert.deepEqual(candidates.FWD, []);
});
