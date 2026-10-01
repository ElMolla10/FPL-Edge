import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isLiveEvent, lockForLiveEvent, lockedLiveSoFar, liveEvent } from "../app/lib/live-lock.ts";
import { resolveCurrentXi, resolveLiveScoring } from "../app/components/coach/PanelShared.tsx";
import type { FplPlayer } from "../app/lib/fpl.ts";

const NOW = Date.parse("2026-10-03T15:00:00Z");
const live = { id: 7, deadline: "2026-10-03T10:00:00Z", finished: false };
const done = { id: 6, deadline: "2026-09-26T10:00:00Z", finished: true };
const pos = ["GKP", "DEF", "DEF", "DEF", "DEF", "MID", "MID", "MID", "MID", "FWD", "FWD", "GKP", "DEF", "MID", "FWD"];
const players = pos.map((p, i) => ({ id: i + 1, name: `P${i + 1}`, positionShort: p, eventPoints: i + 1, eventMinutes: 90, status: "a" } as unknown as FplPlayer));
const lock = { event: 7, lockedAt: "", dataUpdatedAt: "", predicted: 58.4, squadIds: players.map(p => p.id), xiIds: players.slice(0, 11).map(p => p.id), benchIds: [12, 13, 14, 15], captainId: 9, viceId: 10 };

test("no lock → no fabricated receipt", () => {
  assert.equal(lockForLiveEvent(live, [], NOW), null);
  assert.equal(lockForLiveEvent(live, [{ ...lock, event: 6 }], NOW), null);
});
test("lock present → XI and captain match the receipt even after local edits", () => {
  const edited = [...players].reverse(); // user re-saved a different squad order locally
  const res = resolveCurrentXi(edited, players, 7, [], lock, undefined);
  assert.deepEqual(res.xi.map(p => p.id), lock.xiIds);
  assert.deepEqual(res.bench.map(p => p.id), lock.benchIds);
  const found = lockForLiveEvent(live, [lock], NOW)!;
  const s = resolveLiveScoring({ xi: res.xi, bench: res.bench, localCaptainId: found.captainId, localViceId: found.viceId, eventId: 7, deadlinePassed: true, official: null, finalizeAutosubs: false });
  assert.equal(s.captainId, 9);
  assert.equal(lockedLiveSoFar(found, players), s.liveTotal);
  const team = readFileSync("app/components/coach/TeamPanel.tsx", "utf8");
  assert.match(team, /localCaptainId:liveLock\?liveLock\.captainId/);
});
test("finished GW stays on the History path, not the live banner", () => {
  assert.equal(isLiveEvent(done, NOW), false);
  assert.equal(lockForLiveEvent(done, [{ ...lock, event: 6 }], NOW), null);
  assert.equal(liveEvent([done, live], NOW)?.id, 7);
  assert.equal(liveEvent([done], NOW), null);
});
