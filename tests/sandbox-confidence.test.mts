import assert from "node:assert/strict";
import test from "node:test";
import { FplPlayer } from "../app/lib/fpl.ts";
import { deriveSandboxConfidenceComparisons } from "../app/lib/sandbox-confidence.ts";
import { applySandboxTransfer, createSandboxState, resetSandbox, undoSandboxTransfer } from "../app/lib/squad-comparison.ts";

const p = (id: number) => ({ id, positionId: 3, positionShort: "MID" }) as FplPlayer;
const baseline = Array.from({ length: 15 }, (_, index) => p(index + 1));

test("multiple sandbox transfers derive distinct latest and cumulative squad comparisons with the correct hit costs", () => {
  const first = applySandboxTransfer(createSandboxState(baseline), baseline[0], p(101));
  const second = applySandboxTransfer(first, baseline[1], p(102));
  const comparisons = deriveSandboxConfidenceComparisons(second, { incrementalHitChange: 4, cumulativeHitCost: 8 });

  assert.ok(comparisons);
  assert.deepEqual(comparisons.latest.baselineSquad.map(player => player.id), first.currentSquad.map(player => player.id));
  assert.deepEqual(comparisons.latest.candidateSquad.map(player => player.id), second.currentSquad.map(player => player.id));
  assert.equal(comparisons.latest.candidateAdditionalHitCost, 4);
  assert.deepEqual(comparisons.cumulative.baselineSquad.map(player => player.id), baseline.map(player => player.id));
  assert.deepEqual(comparisons.cumulative.candidateSquad.map(player => player.id), second.currentSquad.map(player => player.id));
  assert.equal(comparisons.cumulative.candidateAdditionalHitCost, 8);
});

test("undo restores the preceding comparison and reset removes confidence comparisons without persisting results", () => {
  const first = applySandboxTransfer(createSandboxState(baseline), baseline[0], p(101));
  const second = applySandboxTransfer(first, baseline[1], p(102));
  const undone = undoSandboxTransfer(second);
  const restored = deriveSandboxConfidenceComparisons(undone, { incrementalHitChange: 0, cumulativeHitCost: 0 });

  assert.ok(restored);
  assert.deepEqual(restored.latest.baselineSquad.map(player => player.id), baseline.map(player => player.id));
  assert.deepEqual(restored.latest.candidateSquad.map(player => player.id), first.currentSquad.map(player => player.id));
  assert.equal(deriveSandboxConfidenceComparisons(resetSandbox(second), { incrementalHitChange: 0, cumulativeHitCost: 0 }), null);
  assert.deepEqual(Object.keys(second).sort(), ["baselineSquad", "currentSquad", "financialContext", "history"], "confidence output must never enter sandbox history/state");
});
