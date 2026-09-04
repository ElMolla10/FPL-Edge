import test from "node:test";
import assert from "node:assert/strict";
import { collectSyncPayload, hasMeaningfulData, hydrateFromServer, readFreeTransfers } from "../app/lib/persistence.ts";

// Minimal in-memory localStorage -- Node's own Web Storage API needs --experimental-webstorage
// plus a disk-backed file, which is the wrong shape for a unit test; this stands in for the
// browser global that persistence.ts reads directly.
function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
}
(globalThis as any).localStorage = memoryStorage();

test("readFreeTransfers defaults to 1, not 0, when the key has never been set", () => {
  // Number(null) is 0 in JS, not NaN -- a key that was never written must not be silently read as
  // "0 free transfers" (assume every transfer takes a hit). This is the specific failure mode fixed.
  (globalThis.localStorage as any).clear();
  assert.equal(localStorage.getItem("fpl-edge-free-transfers"), null);
  assert.equal(readFreeTransfers(), 1);
});

test("readFreeTransfers reads back a stored valid value", () => {
  localStorage.setItem("fpl-edge-free-transfers", "3");
  assert.equal(readFreeTransfers(), 3);
  localStorage.setItem("fpl-edge-free-transfers", "0");
  assert.equal(readFreeTransfers(), 0);
});

test("readFreeTransfers falls back to 1 for malformed, empty, or out-of-range values", () => {
  localStorage.setItem("fpl-edge-free-transfers", "");
  assert.equal(readFreeTransfers(), 1);
  localStorage.setItem("fpl-edge-free-transfers", "abc");
  assert.equal(readFreeTransfers(), 1);
  localStorage.setItem("fpl-edge-free-transfers", "-1");
  assert.equal(readFreeTransfers(), 1);
  localStorage.setItem("fpl-edge-free-transfers", "6");
  assert.equal(readFreeTransfers(), 1);
});

test("collectSyncPayload: watchlist, locks, entry and manager are read exactly as before -- the plans addition changed nothing about them", () => {
  (globalThis.localStorage as any).clear();
  localStorage.setItem("fpl-edge-squad", JSON.stringify([1, 2, 3]));
  localStorage.setItem("fpl-edge-watchlist", JSON.stringify([4, 5]));
  localStorage.setItem("fpl-edge-locks", JSON.stringify([{ event: 3 }]));
  localStorage.setItem("fpl-edge-entry", "123456");
  localStorage.setItem("fpl-edge-manager", JSON.stringify({ teamName: "Test FC" }));
  const payload = collectSyncPayload();
  assert.deepEqual(payload.squadIds, [1, 2, 3]);
  assert.deepEqual(payload.watchlist, [4, 5]);
  assert.deepEqual(payload.locks, [{ event: 3 }]);
  assert.equal(payload.entry, "123456");
  assert.deepEqual(payload.manager, { teamName: "Test FC" });
  assert.deepEqual(payload.plans, []); // never set -- must default to empty, not crash
});

test("collectSyncPayload: reads real plans back from fpl-edge-plans, defaulting to [] when absent or malformed", () => {
  (globalThis.localStorage as any).clear();
  assert.deepEqual(collectSyncPayload().plans, []);
  localStorage.setItem("fpl-edge-plans", "not valid json");
  assert.deepEqual(collectSyncPayload().plans, []);
  const plans = [{ id: "p1", name: "My Plan" }];
  localStorage.setItem("fpl-edge-plans", JSON.stringify(plans));
  assert.deepEqual(collectSyncPayload().plans, plans);
});

test("hydrateFromServer: still writes watchlist/locks/entry/manager exactly as before, and now also writes plans", () => {
  (globalThis.localStorage as any).clear();
  hydrateFromServer({
    squadIds: [7, 8], watchlist: [9], locks: [], captainVice: {}, entry: "999", manager: { teamName: "Server FC" },
    plans: [{ id: "p2", name: "Server Plan" }], plannedChips: [],
  });
  assert.deepEqual(JSON.parse(localStorage.getItem("fpl-edge-squad")!), [7, 8]);
  assert.deepEqual(JSON.parse(localStorage.getItem("fpl-edge-watchlist")!), [9]);
  assert.deepEqual(JSON.parse(localStorage.getItem("fpl-edge-locks")!), []);
  assert.equal(localStorage.getItem("fpl-edge-entry"), "999");
  assert.deepEqual(JSON.parse(localStorage.getItem("fpl-edge-manager")!), { teamName: "Server FC" });
  assert.deepEqual(JSON.parse(localStorage.getItem("fpl-edge-plans")!), [{ id: "p2", name: "Server Plan" }]);
});

test("hydrateFromServer: a missing/undefined plans field from the server still writes a real empty array, not the string 'undefined'", () => {
  (globalThis.localStorage as any).clear();
  hydrateFromServer({ squadIds: [], watchlist: [], locks: [], captainVice: {}, entry: null, manager: null, plans: undefined as any, plannedChips: [] });
  assert.deepEqual(JSON.parse(localStorage.getItem("fpl-edge-plans")!), []);
});

test("hasMeaningfulData: a payload with only plans (no squad/watchlist/entry) still counts as meaningful", () => {
  assert.equal(hasMeaningfulData({ squadIds: [], watchlist: [], entry: null, plans: [{ id: "p1" }] }), true);
  assert.equal(hasMeaningfulData({ squadIds: [], watchlist: [], entry: null, plans: [] }), false);
  // Existing squad/watchlist/entry-only cases still work exactly as before.
  assert.equal(hasMeaningfulData({ squadIds: [1], watchlist: [], entry: null }), true);
  assert.equal(hasMeaningfulData({ squadIds: [], watchlist: [], entry: "123" }), true);
});

test("collectSyncPayload: reads real plannedChips back from fpl-edge-planned-chips, defaulting to [] when absent or malformed", () => {
  (globalThis.localStorage as any).clear();
  assert.deepEqual(collectSyncPayload().plannedChips, []);
  localStorage.setItem("fpl-edge-planned-chips", "not valid json");
  assert.deepEqual(collectSyncPayload().plannedChips, []);
  const plannedChips = [{ event: 14, chip: "Wildcard" }];
  localStorage.setItem("fpl-edge-planned-chips", JSON.stringify(plannedChips));
  assert.deepEqual(collectSyncPayload().plannedChips, plannedChips);
});

test("hydrateFromServer: writes plannedChips from the server, defaulting a missing field to a real empty array", () => {
  (globalThis.localStorage as any).clear();
  hydrateFromServer({
    squadIds: [], watchlist: [], locks: [], captainVice: {}, entry: null, manager: null, plans: [],
    plannedChips: [{ event: 20, chip: "Bench Boost" }],
  });
  assert.deepEqual(JSON.parse(localStorage.getItem("fpl-edge-planned-chips")!), [{ event: 20, chip: "Bench Boost" }]);
  hydrateFromServer({ squadIds: [], watchlist: [], locks: [], captainVice: {}, entry: null, manager: null, plans: [], plannedChips: undefined as any });
  assert.deepEqual(JSON.parse(localStorage.getItem("fpl-edge-planned-chips")!), []);
});

test("hasMeaningfulData: a payload with only plannedChips (no squad/watchlist/entry/plans) still counts as meaningful", () => {
  assert.equal(hasMeaningfulData({ squadIds: [], watchlist: [], entry: null, plannedChips: [{ event: 5, chip: "Wildcard" }] }), true);
  assert.equal(hasMeaningfulData({ squadIds: [], watchlist: [], entry: null, plannedChips: [] }), false);
});
