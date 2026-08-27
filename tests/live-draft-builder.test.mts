import assert from "node:assert/strict";
import test from "node:test";
import { resolveResultModeDispatch } from "../app/components/LiveDraftBuilder.tsx";

test("Pure Optimum dispatches to optimize(), ignoring any pinned players", () => {
  assert.deepEqual(resolveResultModeDispatch("Pure Optimum", new Set()), { kind: "optimize" });
  // Pins can be left over from a prior Keep Core session (pin state isn't cleared on mode switch,
  // by design -- see LiveDraftBuilder.tsx). Pure Optimum must still ignore them entirely.
  assert.deepEqual(resolveResultModeDispatch("Pure Optimum", new Set([1, 2, 3])), { kind: "optimize" });
});

test("Practical Upgrade dispatches to optimizeConstrained with maxChanges:3 and no locked players, even if pins exist", () => {
  const dispatch = resolveResultModeDispatch("Practical Upgrade", new Set([1, 2, 3]));
  assert.equal(dispatch.kind, "optimizeConstrained");
  if (dispatch.kind !== "optimizeConstrained") throw new Error("unreachable");
  assert.equal(dispatch.maxChanges, 3);
  // The whole point of this assertion: Practical Upgrade must never lock a player out of the search,
  // regardless of what's pinned from a Keep Core session -- pins are Keep Core-specific input, and
  // silently carrying them into Practical Upgrade would be a real correctness bug, not a cosmetic one.
  assert.equal(dispatch.lockedPlayerIds.size, 0);
});

test("Keep Core dispatches to optimizeConstrained with maxChanges:4 and exactly the passed pinned players", () => {
  const pins = new Set([7, 42]);
  const dispatch = resolveResultModeDispatch("Keep Core", pins);
  assert.equal(dispatch.kind, "optimizeConstrained");
  if (dispatch.kind !== "optimizeConstrained") throw new Error("unreachable");
  assert.equal(dispatch.maxChanges, 4);
  assert.deepEqual(dispatch.lockedPlayerIds, pins);
});

test("Keep Core with no pins yet still dispatches to optimizeConstrained (not Pure Optimum), with an empty locked set", () => {
  const dispatch = resolveResultModeDispatch("Keep Core", new Set());
  assert.equal(dispatch.kind, "optimizeConstrained");
  if (dispatch.kind !== "optimizeConstrained") throw new Error("unreachable");
  assert.equal(dispatch.maxChanges, 4);
  assert.equal(dispatch.lockedPlayerIds.size, 0);
});
