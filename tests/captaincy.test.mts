import assert from "node:assert/strict";
import test from "node:test";
import { FplPlayer } from "../app/lib/fpl.ts";
import { captainRiskNote, resolveCaptaincy } from "../app/components/CoachApp.tsx";

function makePlayer(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1, name: "Player", firstName: "Player", secondName: "One", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: 4, position: "Forward", positionShort: "FWD", price: 8, status: "a", chance: null,
    epNext: 5, form: 5, pointsPerGame: 5, priorPointsPerGame: 5, priorMinutes: 2000, priorStarts: 25,
    priorExpectedGoals: 10, priorExpectedAssists: 3, priorBonus: 15, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 0, totalPoints: 0, eventPoints: 0, selectedBy: 20, priceChange: 0,
    transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0,
    expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 0,
    starts: 0, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0,
    penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
    ...overrides,
  };
}

test("resolveCaptaincy: no players yet -- returns null rather than resolving against an empty squad", () => {
  const result = resolveCaptaincy([], 0, 0, undefined, undefined, undefined, undefined);
  assert.equal(result, null);
});

test("resolveCaptaincy: nothing stored, no manager data -- falls back to the model's own pick", () => {
  const players = [makePlayer({ id: 1 }), makePlayer({ id: 2 })];
  const modelCaptain = players[0];
  const result = resolveCaptaincy(players, 0, 0, undefined, undefined, modelCaptain, undefined);
  assert.equal(result?.captainId, 1);
});

test("resolveCaptaincy: a stored pick always wins over both the official captainId and the model pick", () => {
  const players = [makePlayer({ id: 1 }), makePlayer({ id: 2 }), makePlayer({ id: 3 })];
  const modelCaptain = players[0];
  const result = resolveCaptaincy(players, 3, 0, 2, undefined, modelCaptain, undefined);
  assert.equal(result?.captainId, 3, "an explicitly stored pick must not be overridden by official or model data");
});

// The exact regression: before this fix, Overview had its own two-tier copy of this resolution
// (stored -> model pick only) that silently skipped the official manager captainId entirely.
// Team and Final Check (via useCaptaincy()) always had the full four-tier chain. Right after
// connecting an official team -- before ever touching the CaptaincyPicker dropdown -- if the real
// official captain differed from the model's own top pick, Overview would show a different
// "Projected GW" captain than Team/Final Check showed for the exact same gameweek.
//
// Both call sites now route through this one function, so this proves they can no longer disagree:
// Overview's call shape (no modelVice concept) and useCaptaincy()'s call shape (Team/Final Check,
// which does pass a real modelVice) are exercised side by side with identical underlying data.
test("resolveCaptaincy: Overview and Team/Final Check resolve to the exact same captain when the official captainId differs from both the stored pick (none) and the model pick", () => {
  const players = [
    makePlayer({ id: 1, name: "Model Pick" }),
    makePlayer({ id: 2, name: "Official Pick" }),
    makePlayer({ id: 3, name: "Third" }),
  ];
  const modelCaptain = players[0]; // bestXi()'s own top-projected-points pick
  const modelVice = players[2]; // what useCaptaincy() additionally receives that Overview doesn't
  const managerCaptainId = 2; // the connected account's real official captain -- deliberately NOT the model pick
  const storedCaptainId = 0; // nothing explicitly chosen/saved yet for this event
  const storedViceId = 0;

  const overviewResolution = resolveCaptaincy(players, storedCaptainId, storedViceId, managerCaptainId, undefined, modelCaptain, undefined);
  const teamFinalCheckResolution = resolveCaptaincy(players, storedCaptainId, storedViceId, managerCaptainId, undefined, modelCaptain, modelVice);

  assert.equal(overviewResolution?.captainId, managerCaptainId, "Overview must prefer the official captainId over the model's own pick");
  assert.equal(teamFinalCheckResolution?.captainId, managerCaptainId, "Team/Final Check must prefer the official captainId over the model's own pick");
  assert.equal(
    overviewResolution?.captainId,
    teamFinalCheckResolution?.captainId,
    "Overview and Team/Final Check must resolve to the exact same captain given the same underlying data -- this is the scenario that used to silently disagree",
  );
});

test("resolveCaptaincy: vice never collapses onto the same player as captain, even if manager/model data would otherwise cause it to", () => {
  const players = [makePlayer({ id: 1 }), makePlayer({ id: 2 })];
  const modelCaptain = players[0];
  const modelVice = players[0]; // deliberately the same as captain
  const result = resolveCaptaincy(players, 0, 0, undefined, undefined, modelCaptain, modelVice);
  assert.notEqual(result?.captainId, result?.viceId);
});

// --- captainRiskNote: vice safety net + explicit autosub-for-captaincy warning ---

test("captainRiskNote: captain clears the 68% risk threshold -- no note, this is a safe pick", () => {
  const captain = makePlayer({ id: 1, name: "Haaland" });
  const vice = makePlayer({ id: 2, name: "Salah" });
  const result = captainRiskNote(captain, vice, 90, 85, 9.4, 7.1);
  assert.equal(result, null);
});

test("captainRiskNote: exactly at the 68% boundary -- still no note (matches Final Check's strict <68 risk-flag convention)", () => {
  const captain = makePlayer({ id: 1, name: "Haaland" });
  const vice = makePlayer({ id: 2, name: "Salah" });
  const result = captainRiskNote(captain, vice, 68, 85, 9.4, 7.1);
  assert.equal(result, null);
});

test("captainRiskNote: captain below 68% -- fires, names both players and states the exact swing", () => {
  const captain = makePlayer({ id: 1, name: "Haaland" });
  const vice = makePlayer({ id: 2, name: "Salah" });
  const result = captainRiskNote(captain, vice, 61, 90, 9.4, 7.1);
  assert.ok(result, "expected a risk note when the captain is below the 68% threshold");
  assert.ok(result!.message.includes("Haaland"), "message must name the captain");
  assert.ok(result!.message.includes("Salah"), "message must name the vice");
  assert.ok(result!.message.includes("61%"), "message must state the captain's actual start probability");
  assert.equal(result!.pointsIfCaptainPlays, 18.8, "captain's own doubled points (9.4 * 2)");
  assert.equal(result!.pointsIfArmbandPasses, 14.2, "vice's doubled points if the armband passes (7.1 * 2)");
});

test("captainRiskNote: vice is also below 68% -- message explicitly flags the compounding risk", () => {
  const captain = makePlayer({ id: 1, name: "Haaland" });
  const vice = makePlayer({ id: 2, name: "Salah" });
  const result = captainRiskNote(captain, vice, 55, 60, 9.4, 7.1);
  assert.ok(result?.message.includes("isn't nailed either"), `expected the compounding-risk caveat, got: ${result?.message}`);
  assert.ok(result?.message.includes("60%"), "message must state the vice's own start probability too");
});

test("captainRiskNote: vice is safe (>=68%) -- message does NOT include the compounding-risk caveat", () => {
  const captain = makePlayer({ id: 1, name: "Haaland" });
  const vice = makePlayer({ id: 2, name: "Salah" });
  const result = captainRiskNote(captain, vice, 55, 68, 9.4, 7.1);
  assert.ok(!result?.message.includes("isn't nailed either"), `did not expect the compounding-risk caveat when vice is safe, got: ${result?.message}`);
});
