import assert from "node:assert/strict";
import test from "node:test";
import { confidenceBand, decisionBadge, signedPoints } from "../app/lib/decision-badge.ts";

test("engine states map to MAKE / KEEP / WATCH display words", () => {
  assert.equal(decisionBadge("MAKE", "MAKE").text, "MAKE");
  assert.equal(decisionBadge("MAKE", "LEAN").text, "WATCH");
  assert.equal(decisionBadge("MAKE", "WATCH").text, "WATCH");
  assert.equal(decisionBadge("MAKE", undefined).text, "MAKE");
  assert.equal(decisionBadge("HOLD", "HOLD").text, "KEEP");
  assert.equal(decisionBadge("HOLD", "KEEP").text, "KEEP");
  assert.equal(decisionBadge("MAKE", "ROLL").text, "KEEP");
  assert.equal(decisionBadge("MAKE", "AVOID").text, "KEEP");
});
test("confidence band is derived from the real engine value only", () => {
  assert.equal(confidenceBand(null), null);
  assert.equal(confidenceBand(Number.NaN), null);
  assert.equal(confidenceBand(0.9), "High");
  assert.equal(confidenceBand(0.6), "Medium");
  assert.equal(confidenceBand(0.2), "Low");
});
test("signed points use a real minus sign and one decimal", () => {
  assert.equal(signedPoints(8.64), "+8.6");
  assert.equal(signedPoints(-1.26), "−1.3");
  assert.equal(signedPoints(0), "+0.0");
});

import { plainReason } from "../app/lib/decision-badge.ts";
test("plainReason only rewords, never changes numbers", () => {
  const src = "Modelled +8.6 risk-adj 5-GW NET vs HOLD after Free hit; clears MAKE floor +2.0 with margin.";
  const out = plainReason(src);
  assert.equal(out, "Modelled +8.6 risk-adjusted 5-gameweek net vs keeping after Free hit; clears MAKE floor +2.0 with margin.");
  assert.deepEqual(out.match(/\d+\.\d+/g), src.match(/\d+\.\d+/g));
  assert.equal(plainReason("Type-B HOLD: no transfer now"), "Keep: no transfer now");
});
