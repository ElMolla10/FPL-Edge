import assert from "node:assert/strict";
import test from "node:test";
import { computeDataFreshness } from "../app/lib/data-freshness.ts";

test("computeDataFreshness never says just now and separates Edge vs official ages", () => {
  const now = Date.parse("2026-09-28T12:10:00.000Z");
  const f = computeDataFreshness({
    edgeCalculatedAt: "2026-09-28T12:09:30.000Z",
    officialFetchedAt: "2026-09-28T12:05:00.000Z",
    cacheMaxAgeSeconds: 300,
    nowMs: now,
  });
  assert.doesNotMatch(f.summaryLabel, /just now/i);
  assert.match(f.summaryLabel, /Edge/i);
  assert.match(f.summaryLabel, /Official/i);
  assert.match(f.summaryLabel, /cache ≤5m/);
  assert.equal(f.edgeAgeMinutes, 0);
  assert.equal(f.officialAgeMinutes, 5);
  assert.equal(f.tone, "fresh");
});

test("stale tone when either age exceeds 30 minutes", () => {
  const now = Date.parse("2026-09-28T13:00:00.000Z");
  const f = computeDataFreshness({
    edgeCalculatedAt: "2026-09-28T12:00:00.000Z",
    officialFetchedAt: "2026-09-28T12:00:00.000Z",
    nowMs: now,
  });
  assert.equal(f.tone, "stale");
  assert.equal(f.effectiveAgeMinutes, 60);
});
