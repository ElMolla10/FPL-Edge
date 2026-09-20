import assert from "node:assert/strict";
import test from "node:test";
import { markSignedIn, writeAccountTeam } from "../app/lib/persistence.ts";
import {
  cachedTeamDiffersFromApi,
  refreshConnectedTeamFromApi,
  resetTeamLiveRefreshCooldown,
  shouldReplaceCachedTeam,
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

test("refreshConnectedTeamFromApi: no-op when signed out", async () => {
  (globalThis.localStorage as { clear: () => void }).clear();
  resetTeamLiveRefreshCooldown();
  markSignedIn(false);
  localStorage.setItem("fpl-edge-entry", "261593");
  const result = await refreshConnectedTeamFromApi({ players: liveIds.map((id) => ({ id })) }, { force: true });
  assert.equal(result.updated, false);
  if (!result.updated) assert.equal(result.skipped, "signed-out");
});

test("refreshConnectedTeamFromApi: unchanged live snapshot does not rewrite", async () => {
  (globalThis.localStorage as { clear: () => void }).clear();
  resetTeamLiveRefreshCooldown();
  markSignedIn(true);
  const liveManager = managerSnapshot(0.8, "live-my-team", liveIds);
  // Seed via writeAccountTeam so local matches API
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
