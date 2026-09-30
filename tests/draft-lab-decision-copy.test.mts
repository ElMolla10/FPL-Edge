import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { readCoachSource } from "./helpers/coach-source.mts";

test("Draft Lab: one BEST DECISION headline; optimized-squad compare demoted after Build", () => {
  const src = readFileSync(new URL("../app/components/LiveDraftBuilder.tsx", import.meta.url), "utf8");
  assert.match(src, /selectBestDecision/);
  assert.match(src, /compareTransferToHold/);
  assert.match(src, /BEST DECISION/);
  assert.match(src, /VS OPTIMIZED SQUAD/);
  assert.match(src, /Versus HOLD/);
  assert.match(src, /optimized-squad-compare-details/);
  assert.match(src, /recommendedChanges\.changes\.length>0/);
  assert.match(src, /BEST DECISION above is primary/);
  assert.doesNotMatch(src, /BEST TRANSFER RIGHT NOW/);
  assert.doesNotMatch(src, /Your squad already matches the model suggestion/);
  assert.doesNotMatch(src, /selectPrimaryTransfer/);
});

test("Players table defaults sort to Next GW xPts while keeping both columns", () => {
  const src = readCoachSource();
  assert.match(src, /\["Player","Next GW","5 gameweeks","Price","Ownership","Actions"\]/);
  assert.match(src, /players-xpts/);
  assert.match(src, /useState\("xPts1"\)/);
  assert.match(src, /\["xPts1","Next GW xPts"\],\["xPts5","5-GW xPts"\]/);
});

test("Transfers hero surfaces Immediate net near 5-GW NET primary", () => {
  const src = readCoachSource();
  assert.match(src, /IMMEDIATE NET \(THIS GW\)/);
  assert.match(src, /immediate-net-chip/);
  assert.match(src, /best-decision-immediate/);
  assert.match(src, /5-GW NET vs HOLD/);
});
