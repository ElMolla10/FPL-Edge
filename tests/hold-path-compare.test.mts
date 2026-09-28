import assert from "node:assert/strict";
import test from "node:test";
import { compareTransferToHold, selectBestDecision, type Transfer } from "../app/lib/transfers.ts";

function stubTransfer(overrides: Partial<Transfer> = {}): Transfer {
  const base = {
    out: { id: 1, name: "Out" } as Transfer["out"],
    incoming: { id: 2, name: "In" } as Transfer["incoming"],
    gain1: 0.4, gain3: 1.1, gain5: 2.0,
    individualGain1: 0.4, individualGain3: 1.1, individualGain5: 2.0,
    outGw1: 3, inGw1: 3.4, outGw3: 9, inGw3: 10.1, outGw5: 15, inGw5: 17,
    price: 0.1, minutes: 5, expectedMinutesOut: 70, expectedMinutesIn: 75,
    startProbOut: 0.8, startProbIn: 0.85, dcOut: 0, dcIn: 0,
    attackingOut: 0.3, attackingIn: 0.4, fixtureAdjustmentIn: 3,
    confidenceOut: 0.7, confidenceIn: 0.75,
    teamAttackIn: 1, teamDefenceIn: 1, opponentDefenceIn: 1, opponentAttackIn: 1,
    fixtureAttackMultiplierIn: 1, fixtureDefenceMultiplierIn: 1,
    outMetrics: {} as Transfer["outMetrics"], inMetrics: {} as Transfer["inMetrics"],
    gainBand: "moderate" as Transfer["gainBand"], anomalies: [],
    hitCost: 0, netDifference: 2.0, utilityChange: null, rankScore: 2.0,
    reviewRequired: false, weeklyGains: [0.4, 0.4, 0.4, 0.4, 0.4],
    positiveWeeks: 5, gainWithoutBestWeek: 1.6,
    qualityStatus: "actionable" as const, qualityScore: 80, qualityReasons: [],
    risk: "Low" as const,
  };
  return { ...base, ...overrides } as Transfer;
}

test("compareTransferToHold: HOLD row is zero vs itself", () => {
  const hold = stubTransfer({
    isHold: true,
    classification: "HOLD",
    fiveGwNetVsHold: 0,
    riskAdjustedFiveGwNetVsHold: 0,
    freeTransfersBefore: 1,
    freeTransfersAfter: 2,
  });
  const cmp = compareTransferToHold(hold);
  assert.equal(cmp.isHold, true);
  assert.equal(cmp.thisGwVsHold, 0);
  assert.equal(cmp.fiveGwNetVsHold, 0);
  assert.equal(cmp.riskAdjustedFiveGwNetVsHold, 0);
  assert.equal(cmp.freeTransfersBefore, 1);
  assert.equal(cmp.freeTransfersAfter, 2);
});

test("compareTransferToHold: free transfer this-GW is gross delta (hitCost 0)", () => {
  const move = stubTransfer({
    classification: "MAKE",
    nextGwGross: 52.0,
    holdNextGwGross: 51.0,
    hitCost: 0,
    fiveGwNetVsHold: 1.2,
    riskAdjustedFiveGwNetVsHold: 1.05,
    netEv5: 1.2,
    riskAdjustedNet5: 1.05,
  });
  const cmp = compareTransferToHold(move);
  assert.equal(cmp.isHold, false);
  assert.equal(cmp.thisGwVsHold, 1.0);
  assert.equal(cmp.fiveGwNetVsHold, 1.2);
  assert.equal(cmp.riskAdjustedFiveGwNetVsHold, 1.05);
});

test("compareTransferToHold: hit transfer subtracts hitCost from this-GW vs HOLD", () => {
  const move = stubTransfer({
    classification: "LEAN",
    nextGwGross: 53.0,
    holdNextGwGross: 51.0,
    hitCost: 4,
    hitLabel: "−4",
    fiveGwNetVsHold: 0.5,
    riskAdjustedFiveGwNetVsHold: 0.4,
  });
  const cmp = compareTransferToHold(move);
  // Gross +2.0 this GW, but −4 hit → net −2.0 (matches Immediate net (gross−hit) wording)
  assert.equal(cmp.thisGwVsHold, -2.0);
  assert.equal(cmp.fiveGwNetVsHold, 0.5);
});

test("compareTransferToHold: gain1 fallback also nets hitCost", () => {
  const move = stubTransfer({
    classification: "WATCH",
    gain1: 1.5,
    hitCost: 4,
    // no nextGwGross / holdNextGwGross
    nextGwGross: undefined,
    holdNextGwGross: undefined,
    fiveGwNetVsHold: -1,
  });
  const cmp = compareTransferToHold(move);
  assert.equal(cmp.thisGwVsHold, 1.5 - 4);
});

test("selectBestDecision prefers HOLD when no MAKE/LEAN", () => {
  const hold = stubTransfer({ isHold: true, classification: "HOLD", out: { id: 0, name: "HOLD" } as Transfer["out"] });
  const watch = stubTransfer({ classification: "WATCH", qualityStatus: "watchlist", rankScore: 0.5 });
  const decision = selectBestDecision([watch, hold]);
  assert.ok(decision);
  assert.equal(decision!.classification, "HOLD");
  assert.equal(decision!.isHold, true);
});
