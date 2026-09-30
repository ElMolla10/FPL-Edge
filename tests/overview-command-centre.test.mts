import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  selectBestDecision,
  type Transfer,
} from "../app/lib/transfers.ts";
import {
  withModelUtilityChange,
  rankTransfersForBestDecision,
} from "../app/components/CoachApp.tsx";
import type { FplData, FplPlayer } from "../app/lib/fpl.ts";
import { readCoachSource } from "./helpers/coach-source.mts";

const coach = readCoachSource();
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

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

function moveRow(classification: "MAKE" | "LEAN" | "WATCH", net: number, ids = { out: 1, incoming: 2 }): Transfer {
  return {
    out: { id: ids.out, name: `Out ${ids.out}` } as Transfer["out"],
    incoming: { id: ids.incoming, name: `In ${ids.incoming}` } as Transfer["incoming"],
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
  } as unknown as Transfer;
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

test("Overview preserves hang-safe shallow-first then deferred deep shared Transfers path", () => {
  const overview = overviewSource();
  assert.match(overview, /profile:"overview"/);
  assert.match(overview, /mode:"shallow"/);
  assert.match(overview, /scheduleDeferred/);
  // Deferred deep must use the shared Transfers ranking+utility pipeline — not restricted hang-safe budgets alone.
  assert.match(overview, /rankTransfersForBestDecision\(/);
  assert.doesNotMatch(overview, /maxEvalCandidates:\s*16/);
  assert.doesNotMatch(overview, /planTimeBudgetMs:\s*120/);
  const shallowIdx = overview.indexOf('mode:"shallow"');
  const deferredIdx = overview.indexOf("scheduleDeferred(()");
  const sharedIdx = overview.indexOf("rankTransfersForBestDecision(");
  assert.ok(shallowIdx >= 0 && deferredIdx > shallowIdx, "shallow sync must precede deferred deep call");
  assert.ok(sharedIdx > deferredIdx, "shared Transfers deep path must be inside scheduleDeferred callback");
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
  assert.match(overview, /OverviewDeadlineStrip|UP NEXT|overview-deadline-when/);
  assert.doesNotMatch(overview, /COUNTDOWN|setInterval\(\(\)=>setNow/);
});

test("Transfers page still owns the full BEST DECISION hero and shared ranking helper", () => {
  assert.match(coach, /best-decision-hero/);
  assert.match(coach, /function Transfers\(/);
  const transfersStart = coach.indexOf("function Transfers(");
  const transfersSlice = coach.slice(transfersStart, transfersStart + 14000);
  assert.match(transfersSlice, /selectBestDecision\(/);
  assert.match(transfersSlice, /BEST DECISION/);
  assert.match(transfersSlice, /rankTransfersForBestDecision\(/);
});

test("Overview known-state strip shows bank/FT/chip only when known — no invented personal data", () => {
  const overview = overviewSource();
  assert.match(overview, /overview-status-strip/);
  assert.match(overview, /bankKnown/);
  assert.match(overview, /liveFtKnown/);
  assert.match(overview, /Set in Transfers/);
  assert.match(overview, /plannedChip/);
});

test("Overview keeps the upcoming gameweek date but has no second live countdown", () => {
  const stripStart = coach.indexOf("function OverviewDeadlineStrip(");
  const stripEnd = coach.indexOf("/** Same FT input Transfers uses", stripStart);
  assert.ok(stripStart >= 0 && stripEnd > stripStart, "Overview deadline strip marker must exist");
  const strip = coach.slice(stripStart, stripEnd);
  assert.match(strip, /UP NEXT/);
  assert.match(strip, /overview-deadline-when/);
  assert.match(strip, /event\.deadline/);
  assert.doesNotMatch(strip, /COUNTDOWN|setInterval/);
  assert.doesNotMatch(css, /overview-countdown/);
});

test("model utility pipeline can flip BEST DECISION — identical mock rows alone are not enough", () => {
  const hold = holdRow();
  // Two MAKE rows: raw rankScore prefers A; Transfers applies withModelUtilityChange before selectBestDecision.
  const makeA = moveRow("MAKE", 3.0, { out: 10, incoming: 20 });
  const makeB = moveRow("MAKE", 2.5, { out: 11, incoming: 21 });
  // Engine rows arrive quality-sorted; selectBestDecision uses find(MAKE) on that order.
  // Without utility, higher raw rankScore MAKE (A) stays first.
  const rawDecision = selectBestDecision([hold, makeA, makeB]);
  assert.equal(rawDecision?.incoming.name, "In 20", "without utility, first MAKE in engine order wins");

  const squad = [
    { id: 10, name: "Out 10" },
    { id: 11, name: "Out 11" },
  ] as FplPlayer[];
  // Utility boosts B enough (+2.0 rankScore from clamped utilityChange 10 * 0.2) to overtake A.
  const optimizer = {
    evaluate: (players: FplPlayer[]) => {
      if (players.some((p) => p.id === 21)) return { objective: 50 }; // B swap
      return { objective: 0 }; // baseline / A swap
    },
  } as unknown as Parameters<typeof withModelUtilityChange>[2];

  const adjusted = withModelUtilityChange([hold, makeA, makeB], squad, optimizer);
  const decision = selectBestDecision(adjusted);
  assert.equal(decision?.classification, "MAKE");
  assert.equal(decision?.incoming.name, "In 21", "utility-adjusted ranking must be able to change which MAKE wins");
  assert.notEqual(
    rawDecision?.incoming.id,
    decision?.incoming.id,
    "raw engine rows vs utility-adjusted rows must disagree — Overview omitting withModelUtilityChange is the bug class",
  );
});

test("rankTransfersForBestDecision matches Transfers composition (limit 60 deep + utility)", () => {
  // Source contract: helper is the single shared pipeline both pages call.
  assert.match(coach, /export function rankTransfersForBestDecision/);
  assert.match(coach, /bestTransfers\(data,squad,bank,freeTransfers,60,sellingPrices/);
  assert.match(coach, /withModelUtilityChange\(base,squad,optimizer\)/);

  // Empty / incomplete inputs stay empty (no invented decision).
  const empty = rankTransfersForBestDecision(
    { players: [], fixtures: [], events: [], teams: [], rules: { budget: 100, squadSize: 15, teamLimit: 3, positions: [] }, updatedAt: "", source: "test", seasonStatsThrough: 0 } as FplData,
    [],
    0,
    1,
    new Map(),
    null,
  );
  assert.deepEqual(empty, []);
  assert.equal(selectBestDecision(empty), null);
});

test("Overview deferred deep and Transfers both call rankTransfersForBestDecision (not selector-only share)", () => {
  const overview = overviewSource();
  const transfersStart = coach.indexOf("function Transfers(");
  const transfersSlice = coach.slice(transfersStart, transfersStart + 14000);
  assert.match(overview, /rankTransfersForBestDecision\(/);
  assert.match(transfersSlice, /rankTransfersForBestDecision\(/);
  // Overview must still keep shallow-first; Transfers must not call restricted overview budgets for the hero.
  assert.match(overview, /mode:"shallow"/);
  assert.doesNotMatch(transfersSlice, /profile:"overview"/);
  assert.doesNotMatch(transfersSlice, /maxEvalCandidates:\s*16/);
});
