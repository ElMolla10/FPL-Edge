import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { selectBestDecision, type Transfer } from "../app/lib/transfers.ts";

const coach = readFileSync(new URL("../app/components/CoachApp.tsx", import.meta.url), "utf8");

function overviewSource(): string {
  const start = coach.indexOf("function Overview(");
  const end = coach.indexOf("function WhatChanged(");
  assert.ok(start >= 0 && end > start, "Overview and WhatChanged markers must exist");
  return coach.slice(start, end);
}

function holdRow(partial: Partial<Transfer> = {}): Transfer {
  return {
    out: { id: 0, name: "HOLD" } as Transfer["out"],
    incoming: { id: 0, name: "HOLD" } as Transfer["incoming"],
    gain1: 0, gain3: 0, gain5: 0,
    individualGain1: 0, individualGain3: 0, individualGain5: 0,
    minutes: 0, risk: "Low", confidenceIn: 1, priceDelta: 0,
    qualityStatus: "actionable", rankScore: 0, netDifference: 0,
    hitCost: 0, reviewRequired: false, anomalies: [], gainBand: "flat",
    isHold: true, classification: "HOLD",
    fiveGwNetVsHold: 0, riskAdjustedFiveGwNetVsHold: 0,
    engineReason: "Type-B HOLD",
    ...partial,
  } as Transfer;
}

function moveRow(classification: "MAKE" | "LEAN" | "WATCH", net: number): Transfer {
  return {
    out: { id: 1, name: "Out Player" } as Transfer["out"],
    incoming: { id: 2, name: "In Player" } as Transfer["incoming"],
    gain1: net, gain3: net, gain5: net,
    individualGain1: net, individualGain3: net, individualGain5: net,
    minutes: 10, risk: "Low", confidenceIn: 0.8, priceDelta: 0,
    qualityStatus: classification === "WATCH" ? "watchlist" : "actionable",
    rankScore: net, netDifference: net,
    hitCost: 0, reviewRequired: false, anomalies: [], gainBand: "strong",
    isHold: false, classification,
    fiveGwNetVsHold: net, riskAdjustedFiveGwNetVsHold: net,
    engineReason: `${classification} move`,
    hitLabel: "Free",
  } as Transfer;
}

test("Overview BEST DECISION selector matches Transfers vocabulary (MAKE/LEAN/HOLD)", () => {
  const overview = overviewSource();
  assert.match(overview, /BEST DECISION/);
  assert.match(overview, /selectBestDecision\(/);
  assert.match(overview, /decisionHold/);
  assert.match(overview, /5-GW NET vs HOLD/);
  assert.match(overview, /badge-hold|badge-make/);
  assert.match(overview, /Open Transfers/);
  // Same FT + wildcard inputs as Transfers ranking
  assert.match(overview, /rankingFreeTransfersForDecision|authoritativeFreeTransfers/);
  assert.match(overview, /wildcardActive/);
  assert.match(overview, /managerWildcardActive\(meta\)/);
});

test("Overview preserves hang-safe shallow-first then deferred deep path", () => {
  const overview = overviewSource();
  assert.match(overview, /profile:"overview"/);
  assert.match(overview, /mode:"shallow"/);
  assert.match(overview, /scheduleDeferred/);
  assert.match(overview, /mode:"deep"/);
  assert.match(overview, /maxEvalCandidates:\s*16/);
  assert.match(overview, /planTimeBudgetMs:\s*120/);
  // Deep bestTransfers must sit inside the scheduleDeferred callback, not on first paint.
  const shallowIdx = overview.indexOf('mode:"shallow"');
  const deferredIdx = overview.indexOf("scheduleDeferred(()");
  const deepIdx = overview.indexOf('mode:"deep"');
  assert.ok(shallowIdx >= 0 && deferredIdx > shallowIdx, "shallow sync must precede deferred deep call");
  assert.ok(deepIdx > deferredIdx, "deep upgrade must be inside scheduleDeferred callback");
});

test("Overview signed-out / incomplete-squad empty states stay action-first (no fake personal team)", () => {
  const overview = overviewSource();
  assert.match(overview, /Open Demo/);
  assert.match(overview, /ConnectTeam/);
  assert.match(overview, /Build a squad/);
  assert.doesNotMatch(overview, /fake|placeholder bank|£0\.0m · demo personal/i);
});

test("Overview does not reintroduce tech freshness chip; jumps to Final Check / Transfers / Draft Lab", () => {
  const overview = overviewSource();
  assert.doesNotMatch(overview, /Edge .*Official|cache age|summaryLabel|stale jargon/i);
  assert.doesNotMatch(overview, /publicConnectionStatus|computeDataFreshness/);
  assert.match(overview, /overview-jumps/);
  assert.match(overview, /go\("deadline"\)/);
  assert.match(overview, /go\("transfers"\)/);
  assert.match(overview, /go\("draft"\)/);
  assert.match(overview, /URGENT RISKS|URGENT/);
  assert.match(overview, /CAPTAIN/);
  assert.match(overview, /PROJECTED GW/);
  assert.match(overview, /OverviewDeadlineStrip|COUNTDOWN|GAMEWEEK DEADLINE/);
});

test("selectBestDecision is shared: same rows → same BEST DECISION for Overview and Transfers", () => {
  const hold = holdRow();
  const lean = moveRow("LEAN", 1.5);
  const make = moveRow("MAKE", 4.2);
  const watch = moveRow("WATCH", 0.4);

  // Transfers page hero uses selectBestDecision(rows); Overview must too.
  assert.equal(selectBestDecision([watch, hold])?.classification, "HOLD");
  assert.equal(selectBestDecision([watch, hold, lean])?.classification, "LEAN");
  assert.equal(selectBestDecision([watch, hold, lean, make])?.classification, "MAKE");
  assert.equal(selectBestDecision([make, lean, hold])?.out.name, "Out Player");
  assert.equal(selectBestDecision([make, lean, hold])?.incoming.name, "In Player");
  assert.equal(selectBestDecision([make, lean, hold])?.fiveGwNetVsHold, 4.2);

  // Empty / pending deep upgrade: HOLD when nothing actionable
  assert.equal(selectBestDecision([]) , null);
});

test("Transfers page still owns the full BEST DECISION hero (Overview is a teaser)", () => {
  assert.match(coach, /best-decision-hero/);
  assert.match(coach, /function Transfers\(/);
  const transfersStart = coach.indexOf("function Transfers(");
  const transfersSlice = coach.slice(transfersStart, transfersStart + 12000);
  assert.match(transfersSlice, /selectBestDecision\(/);
  assert.match(transfersSlice, /BEST DECISION/);
});

test("Overview known-state strip shows bank/FT/chip only when known — no invented personal data", () => {
  const overview = overviewSource();
  assert.match(overview, /overview-status-strip/);
  assert.match(overview, /bankKnown/);
  assert.match(overview, /liveFtKnown/);
  assert.match(overview, /Set in Transfers/);
  assert.match(overview, /plannedChip/);
});
