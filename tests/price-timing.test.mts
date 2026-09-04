import assert from "node:assert/strict";
import test from "node:test";
import { FplPlayer, PriceOutlookDay } from "../app/lib/fpl.ts";
import { MEANINGFUL_PRICE_PRESSURE, priceOutlookSignal, priceProtectionAlerts, priceTimingSignal } from "../app/components/CoachApp.tsx";

function outlook(today: number, tomorrow = 0, dayAfter = 0): PriceOutlookDay[] {
  const day = (offsetDays: number, projectedPercent: number): PriceOutlookDay => ({ offsetDays, projectedPercent, likelihood: Math.sign(projectedPercent) * (Math.abs(projectedPercent) >= MEANINGFUL_PRICE_PRESSURE ? 3 : 0) });
  return [day(0, today), day(1, tomorrow), day(2, dayAfter)];
}

function makePlayer(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1, name: "Player", firstName: "Player", secondName: "One", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: 4, position: "Forward", positionShort: "FWD", price: 8, status: "a", chance: null,
    epNext: 5, form: 5, pointsPerGame: 5, priorPointsPerGame: 5, priorMinutes: 2000, priorStarts: 25,
    priorExpectedGoals: 10, priorExpectedAssists: 3, priorBonus: 15, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 0, totalPoints: 0, eventPoints: 0, eventMinutes: 0, eventBonus: 0, eventDefensiveContribution: 0, selectedBy: 20, priceChange: 0, priceProjectionToday: 0, priceChangeSinceStart: 0, priceOutlook: outlook(0),
    transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0,
    expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 0,
    starts: 0, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0,
    penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
    ...overrides,
  };
}

// --- priceTimingSignal: honest framing over FPL's own first-party projection, not an invented heuristic ---

test("priceTimingSignal: strong rise pressure -- direction rise, message states the actual percent", () => {
  const player = makePlayer({ priceProjectionToday: 34.3 });
  const result = priceTimingSignal(player);
  assert.equal(result.direction, "rise");
  assert.ok(result.message.includes("34%"), `expected the message to state 34%, got: ${result.message}`);
});

test("priceTimingSignal: strong fall pressure -- direction fall, message states the absolute percent", () => {
  const player = makePlayer({ priceProjectionToday: -20.3 });
  const result = priceTimingSignal(player);
  assert.equal(result.direction, "fall");
  assert.ok(result.message.includes("20%"), `expected the message to state 20% (not -20%), got: ${result.message}`);
});

test("priceTimingSignal: modest pressure well below the threshold -- stable, no false urgency", () => {
  const player = makePlayer({ priceProjectionToday: 5 });
  const result = priceTimingSignal(player);
  assert.equal(result.direction, "stable");
});

test(`priceTimingSignal: exactly at the +${MEANINGFUL_PRICE_PRESSURE} boundary -- counts as rise`, () => {
  const player = makePlayer({ priceProjectionToday: MEANINGFUL_PRICE_PRESSURE });
  const result = priceTimingSignal(player);
  assert.equal(result.direction, "rise");
});

test(`priceTimingSignal: just below the +${MEANINGFUL_PRICE_PRESSURE} boundary -- still stable`, () => {
  const player = makePlayer({ priceProjectionToday: MEANINGFUL_PRICE_PRESSURE - 0.1 });
  const result = priceTimingSignal(player);
  assert.equal(result.direction, "stable");
});

test(`priceTimingSignal: exactly at the -${MEANINGFUL_PRICE_PRESSURE} boundary -- counts as fall`, () => {
  const player = makePlayer({ priceProjectionToday: -MEANINGFUL_PRICE_PRESSURE });
  const result = priceTimingSignal(player);
  assert.equal(result.direction, "fall");
});

// --- priceOutlookSignal: the real 3-day array, same threshold reused, likelihood used only as a defensive guard ---

test("priceOutlookSignal: classifies all 3 real days independently, same threshold as today", () => {
  const player = makePlayer({ priceOutlook: outlook(20, -18, 5) });
  const result = priceOutlookSignal(player);
  assert.deepEqual(result.map(d => d.direction), ["rise", "fall", "stable"]);
  assert.deepEqual(result.map(d => d.offsetDays), [0, 1, 2]);
});

test("priceOutlookSignal: sorts by offsetDays even if the raw array arrives out of order (defensive, not assumed order)", () => {
  const player = makePlayer({ priceOutlook: [outlook(0, 0, -30)[2], outlook(0, 0, -30)[0], outlook(0, 0, -30)[1]] });
  const result = priceOutlookSignal(player);
  assert.deepEqual(result.map(d => d.offsetDays), [0, 1, 2]);
});

// The one honest use of the undocumented likelihood field: a defensive guard, never displayed.
test("priceOutlookSignal: a day whose likelihood sign disagrees with projectedPercent's sign is treated as stable, not trusted", () => {
  const player = makePlayer({ priceOutlook: [{ offsetDays: 0, projectedPercent: 25, likelihood: -3 }, { offsetDays: 1, projectedPercent: 0, likelihood: 0 }, { offsetDays: 2, projectedPercent: 0, likelihood: 0 }] });
  const result = priceOutlookSignal(player);
  assert.equal(result[0].direction, "stable", "a contradictory likelihood must not be trusted into asserting rise");
});

test("priceOutlookSignal: likelihood of 0 alongside real pressure is not treated as a disagreement", () => {
  const player = makePlayer({ priceOutlook: [{ offsetDays: 0, projectedPercent: 25, likelihood: 0 }, { offsetDays: 1, projectedPercent: 0, likelihood: 0 }, { offsetDays: 2, projectedPercent: 0, likelihood: 0 }] });
  const result = priceOutlookSignal(player);
  assert.equal(result[0].direction, "rise");
});

// --- priceProtectionAlerts: only squad players at real risk of a drop, worst-first ---

test("priceProtectionAlerts: no squad player clears the threshold on any day -- empty", () => {
  const squad = [makePlayer({ id: 1, priceProjectionToday: 5, priceOutlook: outlook(5) }), makePlayer({ id: 2, priceProjectionToday: -10, priceOutlook: outlook(-10) })];
  assert.deepEqual(priceProtectionAlerts(squad), []);
});

test("priceProtectionAlerts: a squad player with real fall pressure TODAY is flagged at offsetDays 0", () => {
  const squad = [makePlayer({ id: 1, name: "AtRisk", priceProjectionToday: -25, priceOutlook: outlook(-25) })];
  const result = priceProtectionAlerts(squad);
  assert.equal(result.length, 1);
  assert.equal(result[0].player.name, "AtRisk");
  assert.equal(result[0].offsetDays, 0);
});

test("priceProtectionAlerts: a squad player with strong RISE pressure is never flagged -- only falls are a risk to protect against", () => {
  const squad = [makePlayer({ id: 1, name: "Rising", priceProjectionToday: 40, priceOutlook: outlook(40) })];
  assert.deepEqual(priceProtectionAlerts(squad), []);
});

test("priceProtectionAlerts: multiple at-risk players (same day) are sorted worst (largest pressure) first", () => {
  const squad = [
    makePlayer({ id: 1, name: "Mild", priceProjectionToday: -16, priceOutlook: outlook(-16) }),
    makePlayer({ id: 2, name: "Severe", priceProjectionToday: -40, priceOutlook: outlook(-40) }),
    makePlayer({ id: 3, name: "Safe", priceProjectionToday: 2, priceOutlook: outlook(2) }),
  ];
  const result = priceProtectionAlerts(squad);
  assert.deepEqual(result.map(a => a.player.name), ["Severe", "Mild"]);
});

// The real behavior change this round: a player stable TODAY but showing real fall pressure in
// FPL's own 3-day window was previously invisible to this function entirely.
test("priceProtectionAlerts: a squad player stable today but at real fall risk in 2 days is now flagged, with the real day offset", () => {
  const squad = [makePlayer({ id: 1, name: "EarlyWarning", priceProjectionToday: 3, priceOutlook: outlook(3, 4, -22) })];
  const result = priceProtectionAlerts(squad);
  assert.equal(result.length, 1);
  assert.equal(result[0].player.name, "EarlyWarning");
  assert.equal(result[0].offsetDays, 2);
  assert.ok(result[0].message.includes("2 days"), `expected the day offset stated in the message, got: ${result[0].message}`);
});

test("priceProtectionAlerts: a player at risk TODAY reports today, even if a later day also shows risk -- earliest day wins", () => {
  const squad = [makePlayer({ id: 1, name: "Both", priceProjectionToday: -18, priceOutlook: outlook(-18, -20, -25) })];
  const result = priceProtectionAlerts(squad);
  assert.equal(result.length, 1);
  assert.equal(result[0].offsetDays, 0);
});

test("priceProtectionAlerts: sorts by earliest risk day first, magnitude tie-breaking within the same day", () => {
  const squad = [
    makePlayer({ id: 1, name: "TomorrowRisk", priceProjectionToday: 2, priceOutlook: outlook(2, -30, 0) }),
    makePlayer({ id: 2, name: "TodayRisk", priceProjectionToday: -16, priceOutlook: outlook(-16, 0, 0) }),
  ];
  const result = priceProtectionAlerts(squad);
  assert.deepEqual(result.map(a => a.player.name), ["TodayRisk", "TomorrowRisk"], "today's risk must be reported before a later day's, regardless of magnitude");
});

test("priceProtectionAlerts: no fetched priceOutlook (empty array, e.g. a fixture that never set it) never crashes -- just no future-day detection", () => {
  const squad = [makePlayer({ id: 1, priceProjectionToday: 3, priceOutlook: [] })];
  assert.deepEqual(priceProtectionAlerts(squad), []);
});
