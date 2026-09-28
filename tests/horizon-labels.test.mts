import assert from "node:assert/strict";
import test from "node:test";
import { horizonModeLabel, immediateGwGapLabel } from "../app/lib/horizon-labels.ts";

test("horizonModeLabel maps GW1 Attack to the real next GW number", () => {
  assert.equal(horizonModeLabel("GW1 Attack", 6), "GW6 Attack");
  assert.equal(horizonModeLabel("GW1 Attack", null), "Next GW Attack");
  assert.equal(horizonModeLabel("Balanced 5 GWs", 6), "Balanced 5 GWs");
});

test("immediateGwGapLabel uses the real next GW", () => {
  assert.equal(immediateGwGapLabel(6), "GW6 gap");
  assert.equal(immediateGwGapLabel(undefined), "next-GW gap");
});
