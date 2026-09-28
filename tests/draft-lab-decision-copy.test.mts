import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("Draft Lab: one BEST DECISION headline; optimized-squad compare labelled separately", () => {
  const src = readFileSync(new URL("../app/components/LiveDraftBuilder.tsx", import.meta.url), "utf8");
  assert.match(src, /selectBestDecision/);
  assert.match(src, /compareTransferToHold/);
  assert.match(src, /BEST DECISION/);
  assert.match(src, /VS OPTIMIZED SQUAD/);
  assert.match(src, /Versus HOLD/);
  assert.match(src, /Separate from BEST DECISION/);
  assert.doesNotMatch(src, /BEST TRANSFER RIGHT NOW/);
  assert.doesNotMatch(src, /Your squad already matches the model suggestion/);
  assert.doesNotMatch(src, /selectPrimaryTransfer/);
});

test("Players table defaults to Next GW + 5-GW xPts columns", () => {
  const src = readFileSync(new URL("../app/components/CoachApp.tsx", import.meta.url), "utf8");
  assert.match(src, /\["Player","Next GW","5 gameweeks","Price","Ownership","Actions"\]/);
  assert.match(src, /players-xpts/);
  assert.match(src, /xPts1/);
});
