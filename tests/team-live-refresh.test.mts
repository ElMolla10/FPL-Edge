import assert from "node:assert/strict";
import test from "node:test";
import { markSignedIn, writeAccountTeam } from "../app/lib/persistence.ts";
import {
  cachedTeamDiffersFromApi,
  refreshConnectedTeamFromApi,
  resetTeamLiveRefreshCooldown,
  shouldForceTeamRefreshOnTransfers,
  shouldReplaceCachedTeam,
  writeLocalTeamCache,
} from "../app/lib/team-live-refresh.ts";

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size; },
  };
}
(globalThis as { localStorage: ReturnType<typeof memoryStorage> }).localStorage = memoryStorage();

const liveIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const staleIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 418, 453, 14, 15]; // Maguire+Barnes stand-ins

function managerSnapshot(bank: number, bankSource: "live-my-team" | "entry-history", ids: number[]) {
  return {
    bank,
    bankSource,
    picks: ids.map((elementId, index) => ({
      elementId,
      position: index + 1,
      multiplier: index < 11 ? 1 : 0,
      isCaptain: index === 0,
      isViceCaptain: index === 1,
      sellingPrice: 5,
    })),
  };
}

test("cachedTeamDiffersFromApi: detects stale bank and squad vs live overlay", () => {
  (globalThis.localStorage as { clear: () => void }).clear();
  localStorage.setItem("fpl-edge-squad", JSON.stringify(staleIds));
  localStorage.setItem("fpl-edge-manager", JSON.stringify(managerSnapshot(2.1, "entry-history", staleIds)));
  assert.equal(cachedTeamDiffersFromApi(liveIds, managerSnapshot(0.8, "live-my-team", liveIds)), true);
});

test("shouldReplaceCachedTeam: live-my-team bank replaces stale cache", () => {
  (globalThis.localStorage as { clear: () => void }).clear();
  localStorage.setItem("fpl-edge-squad", JSON.stringify(staleIds));
  localStorage.setItem("fpl-edge-manager", JSON.stringify(managerSnapshot(2.1, "entry-history", staleIds)));
  assert.equal(
    shouldReplaceCachedTeam({
      liveOverlay: true,
      playerIds: liveIds,
      manager: managerSnapshot(0.8, "live-my-team", liveIds),
    }),
    true,
  );
});

test("shouldForceTeamRefreshOnTransfers: true when bankSource is not live-my-team", () => {
  (globalThis.localStorage as { clear: () => void }).clear();
  localStorage.setItem("fpl-edge-entry", "261593");
  localStorage.setItem("fpl-edge-manager", JSON.stringify(managerSnapshot(2.1, "entry-history", staleIds)));
  assert.equal(shouldForceTeamRefreshOnTransfers(), true);
  writeLocalTeamCache({
    squadIds: liveIds,
    entry: "261593",
    manager: managerSnapshot(0.8, "live-my-team", liveIds),
  });
  assert.equal(shouldForceTeamRefreshOnTransfers(), false);
});

test("refreshConnectedTeamFromApi: replaces stale localStorage when API returns live overlay", async () => {
  (globalThis.localStorage as { clear: () => void }).clear();
  resetTeamLiveRefreshCooldown();
  markSignedIn(true);
  localStorage.setItem("fpl-edge-entry", "261593");
  localStorage.setItem("fpl-edge-squad", JSON.stringify(staleIds));
  localStorage.setItem("fpl-edge-manager", JSON.stringify(managerSnapshot(2.1, "entry-history", staleIds)));

  const originalFetch = globalThis.fetch;
  const putBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/fpl/team")) {
      return {
        ok: true,
        json: async () => ({
          liveOverlay: true,
          playerIds: liveIds,
          manager: managerSnapshot(0.8, "live-my-team", liveIds),
        }),
      } as Response;
    }
    if (url.includes("/api/squad") && init?.method === "PUT") {
      putBodies.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  try {
    const data = { players: liveIds.map((id) => ({ id })) };
    const result = await refreshConnectedTeamFromApi(data, { force: true });
    assert.equal(result.updated, true);
    assert.equal(JSON.parse(localStorage.getItem("fpl-edge-manager")!).bank, 0.8);
    assert.equal(JSON.parse(localStorage.getItem("fpl-edge-manager")!).bankSource, "live-my-team");
    assert.deepEqual(JSON.parse(localStorage.getItem("fpl-edge-squad")!), liveIds);
    assert.equal(putBodies.length, 1);
    assert.equal((putBodies[0].manager as { bank: number }).bank, 0.8);
  } finally {
    globalThis.fetch = originalFetch;
    markSignedIn(false);
    resetTeamLiveRefreshCooldown();
  }
});

test("refreshConnectedTeamFromApi: signed-out + entry still updates localStorage from live overlay", async () => {
  (globalThis.localStorage as { clear: () => void }).clear();
  resetTeamLiveRefreshCooldown();
  markSignedIn(false);
  localStorage.setItem("fpl-edge-entry", "261593");
  localStorage.setItem("fpl-edge-squad", JSON.stringify(staleIds));
  localStorage.setItem("fpl-edge-manager", JSON.stringify(managerSnapshot(2.1, "entry-history", staleIds)));

  const originalFetch = globalThis.fetch;
  let putCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/fpl/team")) {
      return {
        ok: true,
        json: async () => ({
          liveOverlay: true,
          playerIds: liveIds,
          manager: managerSnapshot(0.8, "live-my-team", liveIds),
        }),
      } as Response;
    }
    if (url.includes("/api/squad") && init?.method === "PUT") {
      putCalls += 1;
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  try {
    const result = await refreshConnectedTeamFromApi(
      { players: liveIds.map((id) => ({ id })) },
      { force: true },
    );
    assert.equal(result.updated, true);
    assert.equal(JSON.parse(localStorage.getItem("fpl-edge-manager")!).bank, 0.8);
    assert.equal(JSON.parse(localStorage.getItem("fpl-edge-manager")!).bankSource, "live-my-team");
    assert.deepEqual(JSON.parse(localStorage.getItem("fpl-edge-squad")!), liveIds);
    assert.equal(putCalls, 0, "signed-out refresh must not PUT /api/squad");
  } finally {
    globalThis.fetch = originalFetch;
    resetTeamLiveRefreshCooldown();
  }
});

test("refreshConnectedTeamFromApi: after stale /api/squad hydrate, live refresh overwrites £2.1", async () => {
  (globalThis.localStorage as { clear: () => void }).clear();
  resetTeamLiveRefreshCooldown();
  markSignedIn(true);
  // Simulate account hydrate writing stale public bank
  localStorage.setItem("fpl-edge-entry", "261593");
  localStorage.setItem("fpl-edge-squad", JSON.stringify(staleIds));
  localStorage.setItem("fpl-edge-manager", JSON.stringify(managerSnapshot(2.1, "entry-history", staleIds)));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/fpl/team")) {
      return {
        ok: true,
        json: async () => ({
          liveOverlay: true,
          playerIds: liveIds,
          manager: managerSnapshot(0.8, "live-my-team", liveIds),
        }),
      } as Response;
    }
    if (url.includes("/api/squad") && init?.method === "PUT") {
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  try {
    const result = await refreshConnectedTeamFromApi(
      { players: liveIds.map((id) => ({ id })) },
      { force: true },
    );
    assert.equal(result.updated, true);
    assert.equal(JSON.parse(localStorage.getItem("fpl-edge-manager")!).bank, 0.8);
    assert.ok(!JSON.parse(localStorage.getItem("fpl-edge-squad")!).includes(418), "Maguire must leave cache");
  } finally {
    globalThis.fetch = originalFetch;
    markSignedIn(false);
    resetTeamLiveRefreshCooldown();
  }
});

test("refreshConnectedTeamFromApi: unchanged live snapshot does not rewrite", async () => {
  (globalThis.localStorage as { clear: () => void }).clear();
  resetTeamLiveRefreshCooldown();
  markSignedIn(true);
  const liveManager = managerSnapshot(0.8, "live-my-team", liveIds);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") return { ok: true, json: async () => ({ ok: true }) } as Response;
    return {
      ok: true,
      json: async () => ({ liveOverlay: true, playerIds: liveIds, manager: liveManager }),
    } as Response;
  }) as typeof fetch;
  try {
    await writeAccountTeam({ squadIds: liveIds, entry: "261593", manager: liveManager });
    resetTeamLiveRefreshCooldown();
    let teamGets = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/fpl/team")) {
        teamGets += 1;
        return {
          ok: true,
          json: async () => ({ liveOverlay: true, playerIds: liveIds, manager: liveManager }),
        } as Response;
      }
      if (init?.method === "PUT") throw new Error("must not PUT when unchanged");
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const result = await refreshConnectedTeamFromApi(
      { players: liveIds.map((id) => ({ id })) },
      { force: true },
    );
    assert.equal(result.updated, false);
    if (!result.updated) assert.equal(result.skipped, "unchanged");
    assert.equal(teamGets, 1);
  } finally {
    globalThis.fetch = originalFetch;
    markSignedIn(false);
    resetTeamLiveRefreshCooldown();
  }
});

test("regression: Transfers ranking drops Maguire outs once live cache replaces sold Maguire", async () => {
  // Wire: stale localStorage still had Maguire (418); live API squad sold him. After refresh,
  // saved squad must not retain Maguire so Maguire→Tarkowski cannot remain Actionable.
  const { bestTransfers } = await import("../app/lib/transfers.ts");
  const { deriveSandboxFinancialContext } = await import("../app/lib/squad-comparison.ts");
  const { savedSquad } = await import("../app/lib/fpl.ts");

  (globalThis.localStorage as { clear: () => void }).clear();
  resetTeamLiveRefreshCooldown();
  markSignedIn(false);
  localStorage.setItem("fpl-edge-entry", "261593");
  localStorage.setItem("fpl-edge-squad", JSON.stringify(staleIds));
  localStorage.setItem("fpl-edge-manager", JSON.stringify(managerSnapshot(2.1, "entry-history", staleIds)));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/fpl/team")) {
      return {
        ok: true,
        json: async () => ({
          liveOverlay: true,
          playerIds: liveIds,
          manager: managerSnapshot(0.8, "live-my-team", liveIds),
        }),
      } as Response;
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  try {
    const players = [...new Set([...staleIds, ...liveIds, 229])].map((id) => ({
      id,
      name: id === 418 ? "Maguire" : id === 229 ? "Tarkowski" : `P${id}`,
      firstName: "T",
      secondName: `P${id}`,
      teamId: id === 418 ? 16 : id === 229 ? 9 : (id % 20) + 1,
      teamName: "T",
      teamShort: "T",
      positionId: id === 418 || id === 229 ? 2 : 3,
      position: id === 418 || id === 229 ? "Defender" : "Midfielder",
      positionShort: id === 418 || id === 229 ? "DEF" : "MID",
      price: id === 418 ? 4.9 : id === 229 ? 6.1 : 5,
      status: "a",
      chance: null,
      epNext: id === 229 ? 8 : 3,
      form: 3,
      pointsPerGame: 3,
      priorPointsPerGame: 3,
      priorMinutes: 2500,
      priorStarts: 30,
      priorExpectedGoals: 3,
      priorExpectedAssists: 3,
      priorBonus: 10,
      priorSaves: 0,
      priorPenaltiesSaved: 0,
      priorDefensiveContribution: 100,
      priorSource: "official-pl-history" as const,
      totalPoints: 0,
      eventPoints: 0,
      eventMinutes: 0,
      eventBonus: 0,
      eventDefensiveContribution: 0,
      selectedBy: 10,
      priceChange: 0,
      priceProjectionToday: 0,
      priceChangeSinceStart: 0,
      priceOutlook: [],
      transfersIn: 0,
      transfersOut: 0,
      goals: 0,
      assists: 0,
      expectedGoals: 0,
      expectedAssists: 0,
      expectedGoalInvolvements: 0,
      expectedGoalsConceded: 0,
      cleanSheets: 0,
      goalsConceded: 0,
      minutes: 0,
      starts: 0,
      bonus: 0,
      bps: 0,
      ictIndex: 0,
      influence: 0,
      creativity: 0,
      threat: 0,
      saves: 0,
      penaltiesSaved: 0,
      defensiveContribution: 0,
      clearancesBlocksInterceptions: 0,
      recoveries: 0,
      tackles: 0,
      penaltiesOrder: null,
      directFreekicksOrder: null,
      cornersOrder: null,
      scoutRisks: [],
      news: "",
      newsAdded: null,
    }));
    // Pad to a valid catalog for savedSquad / bestTransfers
    const data = {
      players,
      fixtures: [],
      events: [{ id: 1, name: "GW1", deadline: new Date().toISOString(), current: false, next: true, finished: false, dataChecked: false }],
      teams: [],
      rules: {
        budget: 100,
        squadSize: 15,
        teamLimit: 3,
        positions: [
          { id: 1, name: "Goalkeeper", short: "GKP", squad: 2, minPlay: 1, maxPlay: 1 },
          { id: 2, name: "Defender", short: "DEF", squad: 5, minPlay: 3, maxPlay: 5 },
          { id: 3, name: "Midfielder", short: "MID", squad: 5, minPlay: 2, maxPlay: 5 },
          { id: 4, name: "Forward", short: "FWD", squad: 3, minPlay: 1, maxPlay: 3 },
        ],
      },
      updatedAt: new Date().toISOString(),
      source: "test",
      seasonStatsThrough: 0,
    };

    assert.ok(JSON.parse(localStorage.getItem("fpl-edge-squad")!).includes(418));
    const result = await refreshConnectedTeamFromApi(data, { force: true });
    assert.equal(result.updated, true);
    const squadIds = JSON.parse(localStorage.getItem("fpl-edge-squad")!) as number[];
    assert.ok(!squadIds.includes(418), "live refresh must drop Maguire from fpl-edge-squad");
    const squad = savedSquad(data as never);
    assert.ok(squad && !squad.some((p) => p.id === 418));
    const meta = JSON.parse(localStorage.getItem("fpl-edge-manager")!);
    const finance = deriveSandboxFinancialContext(squad!, data.rules.budget, meta);
    assert.equal(finance.baselineBank, 0.8);
    const rows = bestTransfers(data as never, squad!, finance.baselineBank, 1, 80, finance.baselineSellingPrices);
    assert.ok(
      !rows.some((row) => row.out.id === 418),
      "Transfers must not keep Maguire outs after live API sold Maguire",
    );
  } finally {
    globalThis.fetch = originalFetch;
    resetTeamLiveRefreshCooldown();
  }
});
