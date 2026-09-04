import assert from "node:assert/strict";
import test from "node:test";
import {
  RAW_CHIP_NAME,
  computeChipInventory,
  computeHalfBoundary,
  optimizeChipSchedule,
  scheduleChipsWithPlans,
  planChip,
  removePlannedChip,
  plannedChipFor,
  ChipPortfolioCandidate,
  PlannedChip,
} from "../app/lib/chip-portfolio.ts";
import type { Chip, ChipScore } from "../app/components/LiveIntelligence.tsx";
import type { FplEvent } from "../app/lib/fpl.ts";

const NOW = Date.parse("2027-01-15T00:00:00.000Z");
const past = (offsetDays: number) => new Date(NOW + offsetDays * 86_400_000).toISOString();

function makeEvent(id: number, deadlineOffsetDays: number): FplEvent {
  return { id, name: `Gameweek ${id}`, deadline: past(deadlineOffsetDays), current: false, next: false, finished: deadlineOffsetDays < 0, dataChecked: false };
}

// 38 real events, deadlines spaced a week apart, "now" (NOW) fixed at a known point so
// past/future deadlines are deterministic regardless of when this test actually runs.
function seasonEvents(nowIndex = 20): FplEvent[] {
  return Array.from({ length: 38 }, (_, i) => makeEvent(i + 1, (i + 1 - nowIndex) * 7));
}

const realNow = Date.now;
test.before(() => { Date.now = () => NOW; });
test.after(() => { Date.now = realNow; });

test("computeHalfBoundary: 38 real events resolves to gameweek 19, matching the known real rule", () => {
  assert.equal(computeHalfBoundary(seasonEvents()), 19);
});

test("computeHalfBoundary: an odd real event count still resolves via ceil(), giving the first half the extra week", () => {
  const events = Array.from({ length: 37 }, (_, i) => makeEvent(i + 1, 0));
  assert.equal(computeHalfBoundary(events), 19); // ceil(37/2) = 19
});

test("computeHalfBoundary: empty events returns 0, not a crash", () => {
  assert.equal(computeHalfBoundary([]), 0);
});

test("computeHalfBoundary: unsorted input still resolves correctly (defensive sort, not assumed order)", () => {
  const events = seasonEvents();
  const shuffled = [...events].reverse();
  assert.equal(computeHalfBoundary(shuffled), 19);
});

test("computeChipInventory: null historyChips (no connected entry) is honestly unavailable, not a fabricated inventory", () => {
  const result = computeChipInventory(seasonEvents(), null);
  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") return;
  assert.match(result.reason, /connect your official fpl team/i);
});

test("computeChipInventory: empty events is unavailable with a real reason, not a crash", () => {
  const result = computeChipInventory([], []);
  assert.equal(result.status, "unavailable");
});

test("computeChipInventory: with nothing played yet and both halves still open, all 4 chips remain in both halves", () => {
  // nowIndex=1 -- deadline for GW19 (the boundary) and GW38 (the final event) are both still future.
  const result = computeChipInventory(seasonEvents(1), []);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.halfBoundary, 19);
  assert.equal(result.remaining.length, 8); // 4 chips x 2 halves
  assert.equal(result.expiredUnused.length, 0);
});

test("computeChipInventory: a chip played in the first half is not remaining and not expired -- it was used, not lost", () => {
  const result = computeChipInventory(seasonEvents(1), [{ name: "bboost", event: 5, time: "x" }]);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.ok(!result.remaining.some(e => e.chip === "Bench Boost" && e.half === "first"));
  assert.ok(!result.expiredUnused.some(e => e.chip === "Bench Boost" && e.half === "first"));
  // The second half's Bench Boost is untouched by a first-half use.
  assert.ok(result.remaining.some(e => e.chip === "Bench Boost" && e.half === "second"));
});

test("computeChipInventory: a chip played EXACTLY on the boundary gameweek counts as first-half usage, not second (off-by-one guard)", () => {
  const result = computeChipInventory(seasonEvents(1), [{ name: "wildcard", event: 19, time: "x" }]);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.ok(!result.remaining.some(e => e.chip === "Wildcard" && e.half === "first"), "event===halfBoundary must count as first half");
  assert.ok(result.remaining.some(e => e.chip === "Wildcard" && e.half === "second"), "the second half's own Wildcard must be untouched");
});

test("computeChipInventory: an unused first-half chip EXPIRES once the boundary deadline has passed -- the core off-by-one-risk case", () => {
  // nowIndex=25 -- GW19's deadline (7*(19-25) = -42 days) is in the past; GW38's deadline is future.
  const result = computeChipInventory(seasonEvents(25), []);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  const firstHalfFreeHit = result.expiredUnused.find(e => e.chip === "Free Hit" && e.half === "first");
  assert.ok(firstHalfFreeHit, "an unused first-half chip must expire once GW19's deadline has passed");
  assert.ok(!result.remaining.some(e => e.chip === "Free Hit" && e.half === "first"), "an expired chip must not also appear as remaining");
  // The second half is still open at this point in the season.
  assert.ok(result.remaining.some(e => e.chip === "Free Hit" && e.half === "second"));
});

test("computeChipInventory: a deadline at the EXACT current instant counts as passed, matching \"expires AT the GW19 deadline\" literally, not \"strictly after it\"", () => {
  // GW19's deadline offset is 7*(19-19)=0 days -- exactly NOW, not a day before or after.
  const result = computeChipInventory(seasonEvents(19), []);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.ok(result.expiredUnused.some(e => e.half === "first"), "a deadline exactly at the current instant must already count as expired, not still open");
});

test("computeChipInventory: an unused chip in a half whose deadline has NOT yet passed stays remaining, not expired (the other side of the boundary)", () => {
  const result = computeChipInventory(seasonEvents(1), []);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.expiredUnused.length, 0, "nothing should be expired while the first half's own deadline hasn't passed yet");
});

test("computeChipInventory: both halves closed (season over) expires every still-unused chip in both halves", () => {
  const result = computeChipInventory(seasonEvents(50), []);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.expiredUnused.length, 8);
  assert.equal(result.remaining.length, 0);
});

test("computeChipInventory: an unrecognized chip name in real history data is ignored, not a crash", () => {
  const result = computeChipInventory(seasonEvents(1), [{ name: "some-future-chip", event: 3, time: "x" }]);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.remaining.length, 8); // nothing was recognized as used, so nothing changed
});

test("RAW_CHIP_NAME: maps all 4 app Chip strings to the real FPL internal chip-name strings", () => {
  assert.deepEqual(RAW_CHIP_NAME, { "Wildcard": "wildcard", "Free Hit": "freehit", "Bench Boost": "bboost", "Triple Captain": "3xc" });
});

function candidate(eventId: number, scores: Partial<Record<Chip, number>>): ChipPortfolioCandidate {
  const chip = (score: number): ChipScore => ({ score, detail: `detail-${eventId}-${score}` });
  return {
    event: makeEvent(eventId, 0),
    wildcard: chip(scores["Wildcard"] ?? 1),
    freeHit: chip(scores["Free Hit"] ?? 1),
    benchBoost: chip(scores["Bench Boost"] ?? 1),
    tripleCaptain: chip(scores["Triple Captain"] ?? 1),
  };
}

test("optimizeChipSchedule: degenerate single-chip case matches today's LiveChips behaviour -- picks the real highest-scoring week", () => {
  const candidates = [
    candidate(1, { "Bench Boost": 4 }),
    candidate(2, { "Bench Boost": 9 }),
    candidate(3, { "Bench Boost": 6 }),
  ];
  const result = optimizeChipSchedule(["Bench Boost"], candidates);
  assert.equal(result.length, 1);
  assert.equal(result[0].event.id, 2);
  assert.equal(result[0].score, 9);
  // Exactly the existing LiveChips selection rule: [...rows].sort((a,b)=>b[key].score-a[key].score)[0]
  const expected = [...candidates].sort((a, b) => b.benchBoost.score - a.benchBoost.score)[0];
  assert.equal(result[0].event.id, expected.event.id);
});

test("optimizeChipSchedule: no conflicts needed -- each of two chips gets its own real independent best week", () => {
  const candidates = [
    candidate(1, { "Wildcard": 9, "Free Hit": 2 }),
    candidate(2, { "Wildcard": 3, "Free Hit": 8 }),
  ];
  const result = optimizeChipSchedule(["Wildcard", "Free Hit"], candidates);
  assert.equal(result.length, 2);
  const wc = result.find(r => r.chip === "Wildcard")!;
  const fh = result.find(r => r.chip === "Free Hit")!;
  assert.equal(wc.event.id, 1);
  assert.equal(fh.event.id, 2);
});

test("optimizeChipSchedule: a real conflict (both chips' independent best is the same week) is resolved by real total-value trade-off, not double-booked", () => {
  // Week 1 is Wildcard's best (10) and also Free Hit's best (9). Week 2 is worse for both (Wildcard
  // 6, Free Hit 7). The two REAL legal options are {WC@1,FH@2}=10+7=17 or {WC@2,FH@1}=6+9=15 -- the
  // optimizer must find 17, not silently give week 1 to whichever chip is processed first.
  const candidates = [
    candidate(1, { "Wildcard": 10, "Free Hit": 9 }),
    candidate(2, { "Wildcard": 6, "Free Hit": 7 }),
  ];
  const result = optimizeChipSchedule(["Wildcard", "Free Hit"], candidates);
  const total = result.reduce((s, r) => s + r.score, 0);
  assert.equal(total, 17);
  assert.equal(result.find(r => r.chip === "Wildcard")!.event.id, 1);
  assert.equal(result.find(r => r.chip === "Free Hit")!.event.id, 2);
  // Never two chips in the same week.
  const eventIds = result.map(r => r.event.id);
  assert.equal(new Set(eventIds).size, eventIds.length);
});

test("optimizeChipSchedule: more chips than candidate weeks assigns as many as legally fit, never crashes, never silently returns nothing", () => {
  const candidates = [candidate(1, { "Wildcard": 5, "Free Hit": 5, "Bench Boost": 9, "Triple Captain": 3 })];
  const result = optimizeChipSchedule(["Wildcard", "Free Hit", "Bench Boost", "Triple Captain"], candidates);
  assert.equal(result.length, 1, "only one week exists, so only one chip can be legally placed");
  assert.equal(result[0].chip, "Bench Boost", "the single week must go to whichever chip values it most");
});

test("optimizeChipSchedule: empty chips or empty candidates returns an empty result, not a crash", () => {
  assert.deepEqual(optimizeChipSchedule([], [candidate(1, {})]), []);
  assert.deepEqual(optimizeChipSchedule(["Wildcard"], []), []);
});

test("optimizeChipSchedule: the real worst-case size (4 chips, 19 candidate weeks) resolves correctly and quickly", () => {
  const candidates = Array.from({ length: 19 }, (_, i) => candidate(i + 1, {
    "Wildcard": (i * 7) % 10 + 1,
    "Free Hit": (i * 3) % 10 + 1,
    "Bench Boost": (i * 5) % 10 + 1,
    "Triple Captain": (i * 11) % 10 + 1,
  }));
  // Date.now() is mocked to a fixed instant for this whole file (see test.before above) -- use the
  // real clock here, or this would always measure 0ms regardless of actual performance.
  const started = realNow();
  const result = optimizeChipSchedule(["Wildcard", "Free Hit", "Bench Boost", "Triple Captain"], candidates);
  const elapsedMs = realNow() - started;
  assert.equal(result.length, 4);
  assert.equal(new Set(result.map(r => r.event.id)).size, 4, "all four chips landed in distinct weeks");
  assert.ok(elapsedMs < 2000, `expected the real 93,024-combination worst case to resolve well under 2s, took ${elapsedMs}ms`);
});

// --- plannedChipFor: the exact off-by-one risk every consumer (Overview, Final Check, transfers.ts,
// transfer-routes.ts, and FutureGameweekView's badge) relies on being correct -- a call site reading
// the WRONG event's plan is the real risk here, not this function's own (deliberately tiny) logic.
test("plannedChipFor: returns the planned chip for the CORRECT event, matching it exactly", () => {
  const plannedChips: PlannedChip[] = [{ event: 14, chip: "Triple Captain" }];
  assert.equal(plannedChipFor(plannedChips, 14), "Triple Captain");
});

test("plannedChipFor: a DIFFERENT event -- even adjacent -- returns null, not the wrong chip (off-by-one guard)", () => {
  const plannedChips: PlannedChip[] = [{ event: 14, chip: "Triple Captain" }];
  assert.equal(plannedChipFor(plannedChips, 13), null);
  assert.equal(plannedChipFor(plannedChips, 15), null);
});

test("plannedChipFor: no plans at all returns null, not a crash", () => {
  assert.equal(plannedChipFor([], 14), null);
});

// --- planChip / removePlannedChip: the write path enforcing the real one-chip-per-gameweek rule ---
test("planChip: a brand new chip is added", () => {
  const result = planChip([], { event: 10, chip: "Wildcard" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.plannedChips, [{ event: 10, chip: "Wildcard" }]);
});

test("planChip: planning the SAME chip again for a different week upserts (replaces), never adds a second row", () => {
  const existing: PlannedChip[] = [{ event: 10, chip: "Wildcard" }];
  const result = planChip(existing, { event: 25, chip: "Wildcard" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.plannedChips, [{ event: 25, chip: "Wildcard" }]);
});

test("planChip: a DIFFERENT chip for a gameweek that already holds one is rejected with a reason, not silently overwritten", () => {
  const existing: PlannedChip[] = [{ event: 10, chip: "Wildcard" }];
  const result = planChip(existing, { event: 10, chip: "Bench Boost" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /gameweek 10/i);
  assert.match(result.reason, /wildcard/i);
});

test("planChip: the real one-chip-per-gameweek rule is enforced against every OTHER stored chip, not just a same-name check", () => {
  const existing: PlannedChip[] = [{ event: 10, chip: "Wildcard" }, { event: 20, chip: "Bench Boost" }];
  assert.equal(planChip(existing, { event: 20, chip: "Triple Captain" }).ok, false);
  // A free week is still accepted.
  const result = planChip(existing, { event: 30, chip: "Triple Captain" });
  assert.equal(result.ok, true);
});

test("removePlannedChip: removes only the named chip, leaves every other plan untouched", () => {
  const existing: PlannedChip[] = [{ event: 10, chip: "Wildcard" }, { event: 20, chip: "Bench Boost" }];
  assert.deepEqual(removePlannedChip(existing, "Wildcard"), [{ event: 20, chip: "Bench Boost" }]);
});

test("removePlannedChip: removing a chip that was never planned is a no-op, not a crash", () => {
  const existing: PlannedChip[] = [{ event: 10, chip: "Wildcard" }];
  assert.deepEqual(removePlannedChip(existing, "Free Hit"), existing);
});

// --- computeChipInventory with plannedChips: the inventory must expose the SAME plan the portfolio
// board and the planning surface both read, never a second disagreeing view of it ---
test("computeChipInventory: a planned chip surfaces as plannedEvent on the matching remaining entry, in the correct half", () => {
  const plannedChips: PlannedChip[] = [{ event: 5, chip: "Bench Boost" }]; // GW5 -- first half
  const result = computeChipInventory(seasonEvents(1), [], plannedChips);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  const firstHalf = result.remaining.find(e => e.chip === "Bench Boost" && e.half === "first");
  const secondHalf = result.remaining.find(e => e.chip === "Bench Boost" && e.half === "second");
  assert.equal(firstHalf?.plannedEvent, 5, "the planned half's entry must carry the real planned event id");
  assert.equal(secondHalf?.plannedEvent, null, "the OTHER half's entry for the same chip must not also claim the plan");
});

test("computeChipInventory: no plannedChips argument defaults to [] -- every plannedEvent is null, not a crash", () => {
  const result = computeChipInventory(seasonEvents(1), []);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.ok(result.remaining.every(e => e.plannedEvent === null));
});

// --- scheduleChipsWithPlans: wraps optimizeChipSchedule without touching it -- pinning and the
// real one-chip-per-gameweek exclusion happen in the wrapper, the underlying search is unchanged ---
test("scheduleChipsWithPlans: with no plans at all, output is identical to calling optimizeChipSchedule directly (parity)", () => {
  const candidates = [
    candidate(1, { "Wildcard": 10, "Free Hit": 9 }),
    candidate(2, { "Wildcard": 6, "Free Hit": 7 }),
  ];
  const direct = optimizeChipSchedule(["Wildcard", "Free Hit"], candidates);
  const wrapped = scheduleChipsWithPlans(["Wildcard", "Free Hit"], candidates, []);
  assert.deepEqual(wrapped.map(a => ({ chip: a.chip, event: a.event.id, score: a.score })), direct.map(a => ({ chip: a.chip, event: a.event.id, score: a.score })));
  assert.ok(wrapped.every(a => a.planned === false), "nothing is planned, so every row must be marked planned:false, not left ambiguous");
});

test("scheduleChipsWithPlans: a planned chip is pinned to its week and marked planned:true, using that week's real score", () => {
  const candidates = [
    candidate(1, { "Bench Boost": 4 }),
    candidate(2, { "Bench Boost": 9 }),
  ];
  const result = scheduleChipsWithPlans(["Bench Boost"], candidates, [{ event: 1, chip: "Bench Boost" }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].event.id, 1, "the pin must win even though week 2 scores higher -- it's a commitment, not a suggestion");
  assert.equal(result[0].score, 4);
  assert.equal(result[0].planned, true);
});

// The adversarial case the design explicitly called out: a planned chip's week must be removed from
// the candidate pool for every OTHER remaining chip too, not just chips of the same type -- otherwise
// the free search could double-book the pinned week onto a second chip.
test("scheduleChipsWithPlans: a pinned chip's week is excluded from every OTHER remaining chip's free search -- never double-booked", () => {
  const candidates = [
    candidate(1, { "Wildcard": 10, "Free Hit": 10 }), // week 1 is BOTH chips' best week
    candidate(2, { "Wildcard": 3, "Free Hit": 3 }),
  ];
  const result = scheduleChipsWithPlans(["Wildcard", "Free Hit"], candidates, [{ event: 1, chip: "Wildcard" }]);
  const wc = result.find(a => a.chip === "Wildcard")!;
  const fh = result.find(a => a.chip === "Free Hit")!;
  assert.equal(wc.event.id, 1);
  assert.equal(wc.planned, true);
  assert.equal(fh.event.id, 2, "Free Hit must be pushed to week 2 -- week 1 is reserved by the pin, not free for the optimizer to also hand out");
  assert.equal(fh.planned, false);
});

test("scheduleChipsWithPlans: a plan whose event has fallen out of the candidate pool (stale) is treated as unplanned, not a crash or a forced invalid assignment", () => {
  const candidates = [candidate(2, { "Wildcard": 5 })]; // event 1 (the stale plan's event) no longer exists
  const result = scheduleChipsWithPlans(["Wildcard"], candidates, [{ event: 1, chip: "Wildcard" }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].event.id, 2, "falls back to the free search since the planned week is gone");
  assert.equal(result[0].planned, false);
});
