import test from "node:test";
import assert from "node:assert/strict";
import { readFreeTransfers } from "../app/lib/persistence.ts";

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
