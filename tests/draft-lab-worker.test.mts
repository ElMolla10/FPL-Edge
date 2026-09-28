import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { executeDraftLabOptimizeRequest } from "../app/lib/draft-lab-worker.ts";
import type { FplData, FplPlayer } from "../app/lib/fpl.ts";

function makePlayer(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1, name: "Test", firstName: "Test", secondName: "Player", teamId: 1, teamName: "Test FC", teamShort: "TFC",
    positionId: 3, position: "Midfielder", positionShort: "MID", price: 6, status: "a", chance: null,
    epNext: 2, form: 2, pointsPerGame: 3, priorPointsPerGame: 3, priorMinutes: 2500, priorStarts: 30,
    priorExpectedGoals: 3, priorExpectedAssists: 3, priorBonus: 10, priorSaves: 0, priorPenaltiesSaved: 0,
    priorDefensiveContribution: 100, totalPoints: 0, eventPoints: 0, eventMinutes: 0, eventBonus: 0, eventDefensiveContribution: 0, selectedBy: 10, priceChange: 0, priceProjectionToday: 0, priceChangeSinceStart: 0, priceOutlook: [],
    transfersIn: 0, transfersOut: 0, goals: 0, assists: 0, expectedGoals: 0, expectedAssists: 0,
    expectedGoalInvolvements: 0, expectedGoalsConceded: 0, cleanSheets: 0, goalsConceded: 0, minutes: 900,
    starts: 10, bonus: 0, bps: 0, ictIndex: 0, influence: 0, creativity: 0, threat: 0, saves: 0,
    penaltiesSaved: 0, defensiveContribution: 0, clearancesBlocksInterceptions: 0, recoveries: 0, tackles: 0,
    penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null, scoutRisks: [], news: "", newsAdded: null,
    ...overrides,
  };
}

function baseSquad(): FplPlayer[] {
  const gkps = [1, 2].map((n) => makePlayer({ id: n, positionShort: "GKP", positionId: 1, position: "Goalkeeper", price: 4.5, epNext: 3, teamId: 100 + n }));
  const defs = [11, 12, 13, 14, 15].map((n) => makePlayer({ id: n, positionShort: "DEF", positionId: 2, position: "Defender", price: 5, epNext: 3, teamId: 200 + n }));
  const mids = [21, 22, 23, 24, 25].map((n) => makePlayer({ id: n, positionShort: "MID", positionId: 3, position: "Midfielder", price: 6, epNext: 3, teamId: 300 + n }));
  const fwds = [31, 32, 33].map((n) => makePlayer({ id: n, positionShort: "FWD", positionId: 4, position: "Forward", price: 6, epNext: 3, teamId: 400 + n }));
  return [...gkps, ...defs, ...mids, ...fwds];
}

function makeData(players: FplPlayer[]): FplData {
  const teamIds = [...new Set(players.map((p) => p.teamId))];
  const fixtures = [6, 7, 8, 9, 10].flatMap((event) =>
    teamIds.map((teamId) => ({
      id: event * 10000 + teamId, event, teamH: teamId, teamA: -1, teamHDifficulty: 3, teamADifficulty: 3,
      finished: false, kickoff: null, started: false, teamHScore: null, teamAScore: null,
    })),
  );
  const events = [6, 7, 8, 9, 10].map((id) => ({
    id, name: `Gameweek ${id}`, deadline: new Date(Date.now() + id * 86400000).toISOString(),
    current: false, next: id === 6, finished: false, dataChecked: false,
  }));
  return {
    updatedAt: new Date().toISOString(), source: "test", seasonStatsThrough: 0,
    players, fixtures, events,
    teams: teamIds.map((id) => ({ id, name: `Team ${id}`, short: `T${id}` })),
    rules: {
      budget: 100, squadSize: 15, teamLimit: 3,
      positions: [
        { id: 1, name: "Goalkeeper", short: "GKP", squad: 2, minPlay: 1, maxPlay: 1 },
        { id: 2, name: "Defender", short: "DEF", squad: 5, minPlay: 3, maxPlay: 5 },
        { id: 3, name: "Midfielder", short: "MID", squad: 5, minPlay: 2, maxPlay: 5 },
        { id: 4, name: "Forward", short: "FWD", squad: 3, minPlay: 1, maxPlay: 3 },
      ],
    },
  };
}

test("executeDraftLabOptimizeRequest runs Practical Upgrade off the main thread protocol", () => {
  const squad = baseSquad();
  const upgrade = makePlayer({
    id: 910, positionShort: "MID", positionId: 3, position: "Midfielder", price: 6,
    priorExpectedGoals: 15, priorExpectedAssists: 10, priorMinutes: 2500, priorStarts: 30, teamId: 910,
  });
  const data = makeData([...squad, upgrade]);
  const progress: { phase: string; detail: string; step: number; totalSteps: number; percent: number }[] = [];
  const result = executeDraftLabOptimizeRequest(
    {
      type: "optimize",
      requestId: 7,
      data,
      horizonMode: "Balanced 5 GWs",
      riskMode: "Balanced",
      philosophy: "Maximum xPts",
      resultMode: "Practical Upgrade",
      squad,
      pinnedIds: [],
      practicalMaxChanges: 3,
      keepCoreMaxChanges: 4,
    },
    (p) => progress.push({ phase: p.phase, detail: p.detail, step: p.step, totalSteps: p.totalSteps, percent: p.percent }),
  );
  assert.equal(result.type, "result");
  if (result.type === "result") {
    assert.equal(result.requestId, 7);
    assert.equal(result.squad.length, 15);
    assert.ok(result.durationMs >= 0);
    assert.match(result.modeLabel, /Practical Upgrade/);
  }
  assert.ok(progress.some((p) => p.phase === "started"));
  assert.ok(progress.some((p) => p.phase === "searching"));
  assert.ok(progress.some((p) => p.phase === "finished"));
  assert.ok(progress.every((p) => p.totalSteps === 3 && p.step >= 1 && p.step <= 3));
  assert.ok(progress.some((p) => /Step 1\/3/.test(p.detail)));
  assert.ok(progress.some((p) => /Step 2\/3/.test(p.detail)));
  assert.ok(progress.some((p) => p.percent === 100));
});

test("executeDraftLabOptimizeRequest preserves requestId on failure", () => {
  const result = executeDraftLabOptimizeRequest({
    type: "optimize",
    requestId: 99,
    data: null as any,
    horizonMode: "GW1 Attack",
    riskMode: "Balanced",
    philosophy: "Maximum xPts",
    resultMode: "Pure Optimum",
    squad: [],
    pinnedIds: [],
    practicalMaxChanges: 3,
    keepCoreMaxChanges: 4,
  });
  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.requestId, 99);
});

test("LiveDraftBuilder rebinds worker handlers per run and terminates on cancel", () => {
  const src = readFileSync(new URL("../app/components/LiveDraftBuilder.tsx", import.meta.url), "utf8");
  assert.match(src, /draftWorkerRef\.current\.onmessage=/);
  assert.match(src, /runSettings/);
  assert.match(src, /setOptimizedSettings\(runSettings\)/);
  assert.match(src, /cancelBuildBestSquad/);
  assert.match(src, /draftWorkerRef\.current\?\.terminate/);
  assert.match(src, /Previous result stays visible/);
  // onmessage must be rebound after the create-if (not trapped inside first-create only).
  assert.match(
    src,
    /if\(!draftWorkerRef\.current\)\{[\s\S]*?\}\s*draftWorkerRef\.current\.onmessage=/,
  );
});

test("executeDraftLabOptimizeRequest labels follow the request's own settings", () => {
  const squad = baseSquad();
  const data = makeData(squad);
  const a = executeDraftLabOptimizeRequest({
    type: "optimize",
    requestId: 1,
    data,
    horizonMode: "GW1 Attack",
    riskMode: "Safe",
    philosophy: "Differential",
    resultMode: "Pure Optimum",
    squad,
    pinnedIds: [],
    practicalMaxChanges: 3,
    keepCoreMaxChanges: 4,
  });
  assert.equal(a.type, "result");
  if (a.type === "result") {
    // Internal id is still "GW1 Attack"; modeLabel must show live next GW (6 in this fixture).
    assert.match(a.modeLabel, /GW6 Attack/);
    assert.doesNotMatch(a.modeLabel, /GW1 Attack/);
    assert.match(a.modeLabel, /Safe/);
    assert.match(a.modeLabel, /Differential/);
  }
  const b = executeDraftLabOptimizeRequest({
    type: "optimize",
    requestId: 2,
    data,
    horizonMode: "Long-term 8 GWs",
    riskMode: "Aggressive",
    philosophy: "Maximum xPts",
    resultMode: "Pure Optimum",
    squad,
    pinnedIds: [],
    practicalMaxChanges: 3,
    keepCoreMaxChanges: 4,
  });
  assert.equal(b.type, "result");
  if (b.type === "result") {
    assert.match(b.modeLabel, /Long-term 8 GWs/);
    assert.match(b.modeLabel, /Aggressive/);
    assert.match(b.modeLabel, /Maximum xPts/);
    assert.notEqual(b.modeLabel, a.type === "result" ? a.modeLabel : "");
  }
});
