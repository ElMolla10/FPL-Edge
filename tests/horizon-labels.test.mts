import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { horizonModeLabel, immediateGwGapLabel } from "../app/lib/horizon-labels.ts";

test("horizonModeLabel maps GW1 Attack to the real next GW number", () => {
  assert.equal(horizonModeLabel("GW1 Attack", 6), "GW6 Attack");
  assert.equal(horizonModeLabel("GW1 Attack", null), "Next GW Attack");
  assert.equal(horizonModeLabel("Balanced 5 GWs", 6), "Balanced 5 GWs");
});

test("immediateGwGapLabel uses live next GW", () => {
  assert.equal(immediateGwGapLabel(6), "GW6 gap");
  assert.equal(immediateGwGapLabel(null), "next-GW gap");
});

test("Strategy Board and Draft Lab worker labels avoid raw GW1 when next GW differs", () => {
  const board = readFileSync(new URL("../app/components/CoachApp.tsx", import.meta.url), "utf8");
  assert.match(board, /horizonModeLabel\(mode,boardNextGwId\)/);
  const worker = readFileSync(new URL("../app/lib/draft-lab-worker.ts", import.meta.url), "utf8");
  assert.match(worker, /horizonModeLabel\(request\.horizonMode/);
});
