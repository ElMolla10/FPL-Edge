import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAccuracyReport,
  horizonAccuracyRows,
  sliceByMinutesRisk,
  sliceByPosition,
} from "../app/lib/model-accuracy.ts";
import { minutesRiskBand } from "../app/lib/minutes-risk.ts";

test("minutesRiskBand thresholds", () => {
  assert.equal(minutesRiskBand(0.9), "Secure");
  assert.equal(minutesRiskBand(0.8), "Secure");
  assert.equal(minutesRiskBand(0.5), "Moderate");
  assert.equal(minutesRiskBand(0.49), "Risky");
});

const rows = [
  {
    event: 5,
    playerId: 1,
    positionShort: "MID",
    projectedPoints: 4,
    actualPoints: 6,
    error: 2,
    signedError: 2,
    expectedMinutes: 80,
    actualMinutes: 90,
    startProbability: 0.9,
    started: true,
    confidenceBand: "High",
  },
  {
    event: 5,
    playerId: 2,
    positionShort: "DEF",
    projectedPoints: 3,
    actualPoints: 1,
    error: 2,
    signedError: -2,
    expectedMinutes: 40,
    actualMinutes: 0,
    startProbability: 0.4,
    started: false,
    confidenceBand: "Low",
  },
];

test("sliceByPosition and sliceByMinutesRisk publish separate cohorts", () => {
  const byPos = sliceByPosition(rows);
  assert.deepEqual(byPos.map((s) => s.key), ["DEF", "MID"]);
  const byRisk = sliceByMinutesRisk(rows);
  assert.ok(byRisk.some((s) => s.key === "Secure"));
  assert.ok(byRisk.some((s) => s.key === "Risky"));
});

test("horizonAccuracyRows grades 1/3/5 GW sums from frozen paths", () => {
  const receiptPlayers = [
    [1, 5, "a", null, 4, 80, 0.9, 0.8, 0.2, 0.1, 0.3, [4, 3, 5, 2, 4], 1, "MID", "established-pl", false],
  ] as any;
  const actual = new Map<string, number>([
    ["5:1", 6],
    ["6:1", 2],
    ["7:1", 4],
  ]);
  const hz = horizonAccuracyRows({
    event: 5,
    receiptPlayers,
    actualByEventPlayer: actual,
    completedEventIds: [5, 6, 7],
  });
  assert.ok(hz.some((row) => row.horizon === 1 && row.projectedPoints === 4 && row.actualPoints === 6));
  assert.ok(hz.some((row) => row.horizon === 3 && row.projectedPoints === 12 && row.actualPoints === 12));
  const report = buildAccuracyReport("fpl-edge-test", rows, 1, hz);
  assert.ok(report.byHorizon.length >= 2);
  assert.ok(report.byMinutesRisk.length >= 1);
  assert.ok(report.byPosition.length >= 1);
});
