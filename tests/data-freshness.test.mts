import assert from "node:assert/strict";
import test from "node:test";
import {
  computeDataFreshness,
  officialFetchedAtFromResponses,
} from "../app/lib/data-freshness.ts";

test("computeDataFreshness never says just now and separates Edge vs official ages", () => {
  const now = Date.parse("2026-09-28T12:10:00.000Z");
  const f = computeDataFreshness({
    edgeCalculatedAt: "2026-09-28T12:09:30.000Z",
    officialFetchedAt: "2026-09-28T12:05:00.000Z",
    cacheMaxAgeSeconds: 300,
    staleWhileRevalidateSeconds: 600,
    nowMs: now,
  });
  assert.doesNotMatch(f.summaryLabel, /just now/i);
  assert.match(f.summaryLabel, /Edge/i);
  assert.match(f.summaryLabel, /Official/i);
  assert.match(f.summaryLabel, /cache ≤5m/);
  assert.match(f.summaryLabel, /\+10m stale/);
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

test("missing officialFetchedAt does not pretend official equals Edge rebuild time", () => {
  const now = Date.parse("2026-09-28T12:10:00.000Z");
  const f = computeDataFreshness({
    edgeCalculatedAt: "2026-09-28T12:09:50.000Z",
    officialFetchedAt: null,
    cacheMaxAgeSeconds: 300,
    nowMs: now,
  });
  assert.equal(f.officialFetchedAt, null);
  assert.equal(f.officialAgeMinutes, null);
  assert.match(f.officialLabel, /unknown/i);
  // Floor effective age by cache max-age when official time is unknown
  assert.equal(f.effectiveAgeMinutes, 5);
});

test("officialFetchedAtFromResponses returns unknown when Date and Age are missing", () => {
  const response = new Response("{}");
  assert.equal(
    officialFetchedAtFromResponses([response], Date.parse("2026-09-28T12:05:00.000Z")),
    null,
  );
});

test("officialFetchedAtFromResponses prefers earlier Date/Age evidence", () => {
  const older = new Response("{}", {
    headers: { Date: "Mon, 28 Sep 2026 11:00:00 GMT", Age: "120" },
  });
  const newer = new Response("{}", {
    headers: { Date: "Mon, 28 Sep 2026 12:00:00 GMT" },
  });
  const iso = officialFetchedAtFromResponses([newer, older], Date.parse("2026-09-28T12:05:00.000Z"));
  // Age 120s on a Date of 11:00 → ~10:58; Date of older response alone is 11:00 — earliest wins
  assert.ok(iso);
  const ms = Date.parse(iso);
  assert.ok(ms <= Date.parse("2026-09-28T11:00:00.000Z"));
});
