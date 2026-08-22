import assert from "node:assert/strict";
import test from "node:test";
import { LockRecord, reconcileLock } from "../app/components/CoachApp.tsx";

function makeLock(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    event: 5,
    lockedAt: "2026-08-20T10:00:00.000Z",
    dataUpdatedAt: "2026-08-20T09:55:00.000Z",
    predicted: 62.4,
    squadIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    xiIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    captainId: 1,
    viceId: 2,
    ...overrides,
  };
}

test("reconcileLock: no lock exists for this event -- status is none", () => {
  const status = reconcileLock(undefined, { xiIds: [1, 2, 3], captainId: 1, viceId: 2 });
  assert.equal(status, "none");
});

test("reconcileLock: current state exactly matches the lock -- status is matches", () => {
  const lock = makeLock();
  const status = reconcileLock(lock, { xiIds: lock.xiIds, captainId: lock.captainId, viceId: lock.viceId });
  assert.equal(status, "matches");
});

test("reconcileLock: xiIds match regardless of order -- not a false-positive mismatch", () => {
  const lock = makeLock({ xiIds: [1, 2, 3, 4, 5] });
  const status = reconcileLock(lock, { xiIds: [5, 4, 3, 2, 1], captainId: lock.captainId, viceId: lock.viceId });
  assert.equal(status, "matches");
});

// The exact silent-contradiction scenario from the audit: you lock a plan, then the underlying
// projection/squad state changes (a status update, a price move) so analysis()/bestXi() now
// resolves a *different* captain -- everything else about the squad is untouched. Before this
// fix, Final Check would just display the new captain with the lock button silently reset to
// "LOCK THIS TEAM", with no indication your actual locked plan now disagrees. reconcileLock
// returning "mismatch" here is exactly the signal FinalCheck's render gates the banner on
// (`lockStatus === "mismatch"`), so this proves the banner fires instead of staying silent.
test("reconcileLock: locked plan, then projection state changes the resolved captain -- mismatch, not silent", () => {
  const lockedPlan = makeLock({ xiIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], captainId: 1, viceId: 2 });
  // Same XI, same vice -- only the captain resolution changed (e.g. a news update shifted who
  // the model/manager now points to as captain for this event).
  const currentStateAfterMutation = { xiIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], captainId: 3, viceId: 2 };
  const status = reconcileLock(lockedPlan, currentStateAfterMutation);
  assert.equal(status, "mismatch");
});

test("reconcileLock: locked plan, then the resolved XI itself changes (a bench player rotates in) -- mismatch", () => {
  const lockedPlan = makeLock({ xiIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], captainId: 1, viceId: 2 });
  const currentStateAfterMutation = { xiIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 99], captainId: 1, viceId: 2 };
  const status = reconcileLock(lockedPlan, currentStateAfterMutation);
  assert.equal(status, "mismatch");
});

test("reconcileLock: locked plan, then only the vice changes -- still flagged as mismatch", () => {
  const lockedPlan = makeLock({ xiIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], captainId: 1, viceId: 2 });
  const currentStateAfterMutation = { xiIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], captainId: 1, viceId: 7 };
  const status = reconcileLock(lockedPlan, currentStateAfterMutation);
  assert.equal(status, "mismatch");
});
