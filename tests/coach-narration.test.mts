import assert from "node:assert/strict";
import test from "node:test";
import { FplPlayer } from "../app/lib/fpl.ts";
import {
  narrateCaptainChoice,
  narrateChipDecision,
  narrateCurrentRank,
  narrateDifferentials,
  narrateLiveStatus,
  narratePrimaryTransfer,
  narratePriceRisk,
  narrateSquadBuild,
  narrateTransferForPlayer,
  resolveChipLegality,
} from "../app/lib/coach-narration.ts";
import type { ChipInventoryResult } from "../app/lib/chip-portfolio.ts";
import type { CaptaincyRiskFraming, CaptainCandidate, LiveScoringResult, PriceRiskAlert } from "../app/components/CoachApp.tsx";
import type { Transfer } from "../app/lib/transfers.ts";
import type { DifferentialEntry } from "../app/lib/ownership-radar.ts";
import type { WeekPlan } from "../app/lib/optimizer.ts";
import type { ManagerMeta } from "../app/lib/squad-comparison.ts";
import type { LiveMover } from "../app/lib/fpl.ts";

function makePlayer(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1, name: "Player", firstName: "Player", secondName: "One", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: 3, position: "Midfielder", positionShort: "MID", price: 6, status: "a", chance: null,
    epNext: 3, form: 3, pointsPerGame: 3, priorPointsPerGame: 3, priorMinutes: 2500, priorStarts: 30,
    priorExpectedGoals: 3, priorExpectedAssists: 3, priorBonus: 10, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 100, totalPoints: 0, eventPoints: 0, eventMinutes: 0, eventBonus: 0, eventDefensiveContribution: 0,
    selectedBy: 10, priceChange: 0, priceProjectionToday: 0, priceChangeSinceStart: 0, priceOutlook: [],
    transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0,
    expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 0,
    starts: 0, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0,
    penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<CaptainCandidate> = {}): CaptainCandidate {
  return { id: 1, name: "Player", xPts: 5, ret: 60, haul: 20, startProbability: 90, selectedBy: 10, ...overrides };
}

// --- narrateCaptainChoice ---

test("narrateCaptainChoice: interpolates the real xPts/start/ownership of BOTH players, not a fabricated comparison", () => {
  const chosen = candidate({ id: 2, name: "Isak", xPts: 8.4, startProbability: 91, selectedBy: 17.3 });
  const current = candidate({ id: 1, name: "Haaland", xPts: 7.1, startProbability: 88, selectedBy: 62.5 });
  const framing: CaptaincyRiskFraming = { defaultRole: "balanced", safeAlternative: null, differentialAlternative: null };
  const result = narrateCaptainChoice(chosen, current, framing);
  assert.ok(result.includes("8.4"), `expected chosen's real xPts 8.4 in output, got: ${result}`);
  assert.ok(result.includes("7.1"), `expected current's real xPts 7.1 in output, got: ${result}`);
  assert.ok(result.includes("17.3") && result.includes("62.5"), `expected both real ownership numbers, got: ${result}`);
});

test("narrateCaptainChoice: choosing the resolved default captain narrates the real framing role, not a comparison", () => {
  const current = candidate({ id: 1, name: "Haaland" });
  const framing: CaptaincyRiskFraming = { defaultRole: "safe", safeAlternative: null, differentialAlternative: null };
  const result = narrateCaptainChoice(current, current, framing);
  assert.ok(result.includes("Haaland") && result.includes("safest"), `expected the real safe-role framing language, got: ${result}`);
});

test("narrateCaptainChoice: choosing the real safe alternative names it as such using the engine's own real classification", () => {
  const chosen = candidate({ id: 3, name: "Salah" });
  const current = candidate({ id: 1, name: "Haaland" });
  const framing: CaptaincyRiskFraming = { defaultRole: "balanced", safeAlternative: chosen, differentialAlternative: null };
  const result = narrateCaptainChoice(chosen, current, framing);
  assert.ok(result.includes("real safe alternative"), `expected the safe-alternative framing language, got: ${result}`);
});

// --- narratePrimaryTransfer ---

test("narratePrimaryTransfer: interpolates the real out/incoming names and real gain5/minutes/risk", () => {
  const move = { out: { name: "Wilson" }, incoming: { name: "Watkins" }, gain5: 6.7, minutes: 45, risk: "Medium" } as Transfer;
  const result = narratePrimaryTransfer(move);
  assert.ok(result.includes("Wilson") && result.includes("Watkins"));
  assert.ok(result.includes("6.7"), `expected real gain5, got: ${result}`);
  assert.ok(result.includes("45"), `expected real minutes, got: ${result}`);
  assert.ok(result.includes("Medium"));
});

test("narratePrimaryTransfer: null move (roll) is a real, honest decline, not a fabricated recommendation", () => {
  const result = narratePrimaryTransfer(null);
  assert.ok(result.toLowerCase().includes("roll"));
});

// --- narrateTransferForPlayer ---

test("narrateTransferForPlayer: interpolates the real rank position and real transfer numbers when found", () => {
  const match = { out: { name: "Wilson" }, gain5: 9.2, risk: "Low" } as Transfer;
  const result = narrateTransferForPlayer(match, 3, 12, "Watkins");
  assert.ok(result.includes("#3"), `expected the real rank position, got: ${result}`);
  assert.ok(result.includes("12"), `expected the real limit bound, got: ${result}`);
  assert.ok(result.includes("9.2"));
  assert.ok(result.includes("Watkins") && result.includes("Wilson"));
});

test("narrateTransferForPlayer: not found reports the real limit bound honestly, not a guess", () => {
  const result = narrateTransferForPlayer(undefined, null, 12, "Obscure Player");
  assert.ok(result.includes("Obscure Player") && result.includes("12"));
});

// --- narratePriceRisk ---

test("narratePriceRisk: surfaces the alert's own already-composed real message verbatim", () => {
  const player = makePlayer({ id: 1, name: "Palmer" });
  const alert: PriceRiskAlert = { player, offsetDays: 1, pct: 22, message: "carries 22% fall pressure in 1 day -- selling before then protects the standard £0.1m step." };
  const result = narratePriceRisk(alert, "Palmer");
  assert.ok(result.includes(alert.message), `expected the real composed message verbatim, got: ${result}`);
  assert.ok(result.includes("22%"));
});

test("narratePriceRisk: no alert is a real, honest absence-of-risk statement", () => {
  const result = narratePriceRisk(undefined, "Palmer");
  assert.ok(result.includes("Palmer") && result.toLowerCase().includes("isn't currently flagged"));
});

// --- resolveChipLegality (precondition/decline logic, extracted so it has direct test coverage) ---

test("resolveChipLegality: inventory unavailable surfaces the engine's own real reason, not a fabricated one", () => {
  const inventory: ChipInventoryResult = { status: "unavailable", reason: "Connect your official FPL team to see your real remaining chip inventory." };
  const result = resolveChipLegality(inventory, "Wildcard", 12);
  assert.equal(result.reason, "Connect your official FPL team to see your real remaining chip inventory.");
  assert.equal(result.legal, false);
});

test("resolveChipLegality: a chip remaining in the real half for this event is legal", () => {
  const inventory: ChipInventoryResult = { status: "available", halfBoundary: 19, remaining: [{ chip: "Wildcard", half: "first", plannedEvent: null }], expiredUnused: [] };
  const result = resolveChipLegality(inventory, "Wildcard", 5);
  assert.equal(result.legal, true);
  assert.equal(result.expired, false);
  assert.equal(result.reason, null);
});

test("resolveChipLegality: a chip already used/not remaining for the real half is illegal but not expired", () => {
  const inventory: ChipInventoryResult = { status: "available", halfBoundary: 19, remaining: [], expiredUnused: [] };
  const result = resolveChipLegality(inventory, "Wildcard", 5);
  assert.equal(result.legal, false);
  assert.equal(result.expired, false);
});

test("resolveChipLegality: a chip in the real expiredUnused list is distinguished as expired", () => {
  const inventory: ChipInventoryResult = { status: "available", halfBoundary: 19, remaining: [], expiredUnused: [{ chip: "Bench Boost", half: "first", plannedEvent: null }] };
  const result = resolveChipLegality(inventory, "Bench Boost", 5);
  assert.equal(result.legal, false);
  assert.equal(result.expired, true);
});

test("resolveChipLegality: the real halfBoundary decides which half an event belongs to, not a guess", () => {
  const inventory: ChipInventoryResult = { status: "available", halfBoundary: 19, remaining: [{ chip: "Free Hit", half: "second", plannedEvent: null }], expiredUnused: [] };
  assert.equal(resolveChipLegality(inventory, "Free Hit", 5).legal, false, "event 5 is in the first half, but Free Hit is only remaining in the second");
  assert.equal(resolveChipLegality(inventory, "Free Hit", 25).legal, true, "event 25 is in the second half, where Free Hit really is remaining");
});

// --- narrateChipDecision ---

test("narrateChipDecision: legal chip interpolates the real detail string and real score", () => {
  const result = narrateChipDecision("Triple Captain", { legal: true, expired: false, reason: null }, "GW12", { score: 8, detail: "Strong fixture for your captain this week." });
  assert.ok(result.includes("Strong fixture for your captain this week."), `expected the real detail string, got: ${result}`);
  assert.ok(result.includes("8/10"), `expected the real score, got: ${result}`);
  assert.ok(result.includes("GW12"));
});

test("narrateChipDecision: expired chip is distinguished honestly from an ordinary illegal week", () => {
  const expired = narrateChipDecision("Wildcard", { legal: false, expired: true, reason: null }, "GW20", null);
  assert.ok(expired.toLowerCase().includes("closed"));
  const illegal = narrateChipDecision("Wildcard", { legal: false, expired: false, reason: null }, "GW20", null);
  assert.ok(!illegal.toLowerCase().includes("closed"), "an ordinary illegal week must not be described as expired");
});

test("narrateChipDecision: a real unavailable-inventory reason surfaces verbatim, bypassing the legal/expired framing entirely", () => {
  const result = narrateChipDecision("Wildcard", { legal: false, expired: false, reason: "Connect your official FPL team to see your real remaining chip inventory." }, "GW20", null);
  assert.equal(result, "Connect your official FPL team to see your real remaining chip inventory.");
});

// --- narrateDifferentials ---

test("narrateDifferentials: interpolates the real player names, ownership and xPts5 for every entry", () => {
  const entries: readonly DifferentialEntry[] = [
    { player: makePlayer({ id: 1, name: "Mbeumo", selectedBy: 8.4 }), xPts5: 24.7 },
    { player: makePlayer({ id: 2, name: "Semenyo", selectedBy: 3.1 }), xPts5: 19.2 },
  ];
  const result = narrateDifferentials("Midfielder", entries);
  assert.ok(result.includes("Mbeumo") && result.includes("8.4") && result.includes("24.7"));
  assert.ok(result.includes("Semenyo") && result.includes("3.1") && result.includes("19.2"));
});

test("narrateDifferentials: no real candidates is honest, not a fabricated pick", () => {
  const result = narrateDifferentials("Goalkeeper", []);
  assert.ok(result.includes("Goalkeeper") && result.toLowerCase().includes("no real"));
});

// --- narrateLiveStatus ---

test("narrateLiveStatus: interpolates the real live total, active chip and multiplier", () => {
  const scoring = { liveTotal: 63.5, activeChip: "3xc", captainMultiplier: 3, swaps: [] } as unknown as LiveScoringResult;
  const result = narrateLiveStatus(scoring, { hurting: [], helping: [] }, "GW9");
  assert.ok(result.includes("63.5"), `expected the real live total, got: ${result}`);
  assert.ok(result.includes("×3"), `expected the real captain multiplier, got: ${result}`);
  assert.ok(result.includes("GW9"));
});

test("narrateLiveStatus: interpolates real autosub swaps and real hurting/helping deltas", () => {
  const scoring = { liveTotal: 40, activeChip: null, captainMultiplier: 2, swaps: [{ outId: 1, outName: "Injured Player", inId: 2, inName: "Sub Player" }] } as unknown as LiveScoringResult;
  const helping: readonly LiveMover[] = [{ player: makePlayer({ id: 3, name: "Salah" }), countedActual: 12, countedProjected: 6, delta: 6 }];
  const result = narrateLiveStatus(scoring, { hurting: [], helping }, "GW9");
  assert.ok(result.includes("Injured Player") && result.includes("Sub Player"), `expected the real swap names, got: ${result}`);
  assert.ok(result.includes("Salah") && result.includes("+6.0"), `expected the real mover delta, got: ${result}`);
});

// --- narrateCurrentRank ---

test("narrateCurrentRank: interpolates the real overall rank and points, explicitly not a projection", () => {
  const meta = { teamName: "El Molla FC", overallRank: 145203, overallPoints: 412 } as ManagerMeta;
  const result = narrateCurrentRank(meta);
  assert.ok(result.includes("145,203"), `expected the real rank formatted, got: ${result}`);
  assert.ok(result.includes("412"));
  assert.ok(result.toLowerCase().includes("not a forward projection"));
});

// --- narrateSquadBuild ---

test("narrateSquadBuild: interpolates the real formation, captain name and projected points", () => {
  const week = { formation: "3-4-3", captain: makePlayer({ name: "Haaland" }), points: 68.4 } as WeekPlan;
  const result = narrateSquadBuild(week, "Balanced 5 GWs");
  assert.ok(result.includes("3-4-3") && result.includes("Haaland") && result.includes("68.4"));
  assert.ok(result.includes("Balanced 5 GWs"));
});
