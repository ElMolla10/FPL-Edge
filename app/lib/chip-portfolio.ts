import type { FplEvent } from "./fpl";
import type { Chip, ChipScore } from "../components/LiveIntelligence";
import { persist } from "./persistence";

// The one place the app's Chip strings map to FPL's own internal chip-name strings (confirmed
// against real live data this season: "bboost" and "3xc" observed directly; "wildcard"/"freehit"
// are the well-established official strings for the other two). Never redeclared elsewhere.
export const RAW_CHIP_NAME: Record<Chip, string> = {
  "Wildcard": "wildcard",
  "Free Hit": "freehit",
  "Bench Boost": "bboost",
  "Triple Captain": "3xc",
};

const ALL_CHIPS: readonly Chip[] = ["Wildcard", "Free Hit", "Bench Boost", "Triple Captain"];

/**
 * No dedicated "half-boundary" field exists anywhere in FPL's real bootstrap-static event data --
 * confirmed by inspecting every field on all 38 real events this season, including `overrides`
 * (FPL's own real per-gameweek rule-change mechanism), which is empty on every one of them. This is
 * therefore a derived inference from the real, already-fetched event count, not a hardcoded
 * calendar gameweek -- for this season's real 38 events it resolves to 19, matching the known rule,
 * but it stays correct if a real season's total gameweek count ever differs. Callers must disclose
 * this as inferred, never as a directly-sourced fact.
 */
export function computeHalfBoundary(events: readonly FplEvent[]): number {
  if (!events.length) return 0;
  const sorted = [...events].sort((a, b) => a.id - b.id);
  const index = Math.ceil(sorted.length / 2) - 1;
  return sorted[index].id;
}

export type HistoryChipEntry = Readonly<{ name: string; event: number; time: string }>;
// plannedEvent surfaces a local, unconfirmed intent (see PlannedChip below) against this specific
// remaining slot -- null whenever nothing is planned for it, or when a plan exists for this chip
// but resolves to the OTHER half (a chip can only be "planned" for one half at a time).
export type ChipInventoryEntry = Readonly<{ chip: Chip; half: "first" | "second"; plannedEvent: number | null }>;

export type ChipInventoryResult =
  | { status: "available"; halfBoundary: number; remaining: readonly ChipInventoryEntry[]; expiredUnused: readonly ChipInventoryEntry[] }
  | { status: "unavailable"; reason: string };

/**
 * A chip is "remaining" only while its own half's boundary deadline hasn't passed yet -- an unused
 * first-half chip does not carry over once GW19's real deadline (the computed halfBoundary event's
 * own deadline) has passed; it moves to expiredUnused, never silently disappears and never silently
 * counts as still available. The second half's own "window closed" check uses the real final
 * event's deadline the same way, rather than a special-cased end-of-season rule.
 *
 * plannedChips (default []) is the single, unified "what am I planning to play, and when" store --
 * the same PlannedChip[] the captain picker and the Wildcard/Free Hit planning surface both read
 * and write, so this inventory can never disagree with them about which chip is spoken for. A plan
 * whose event no longer resolves to a real remaining slot (stale, or already used/expired) simply
 * surfaces no plannedEvent here -- it isn't an error, the plan has just been superseded by reality.
 */
export function computeChipInventory(
  events: readonly FplEvent[],
  historyChips: readonly HistoryChipEntry[] | null,
  plannedChips: readonly PlannedChip[] = [],
): ChipInventoryResult {
  if (historyChips === null) {
    return { status: "unavailable", reason: "Connect your official FPL team to see your real remaining chip inventory." };
  }
  if (!events.length) {
    return { status: "unavailable", reason: "No official gameweek data is available yet to compute the chip calendar." };
  }
  const halfBoundary = computeHalfBoundary(events);
  const sorted = [...events].sort((a, b) => a.id - b.id);
  const boundaryEvent = sorted.find(e => e.id === halfBoundary) ?? sorted[sorted.length - 1];
  const finalEvent = sorted[sorted.length - 1];
  const firstHalfClosed = Date.parse(boundaryEvent.deadline) <= Date.now();
  const secondHalfClosed = Date.parse(finalEvent.deadline) <= Date.now();

  const usedFirst = new Set<Chip>();
  const usedSecond = new Set<Chip>();
  for (const entry of historyChips) {
    const chip = ALL_CHIPS.find(c => RAW_CHIP_NAME[c] === entry.name);
    if (!chip) continue; // an unrecognized chip name is ignored, not a crash
    (entry.event <= halfBoundary ? usedFirst : usedSecond).add(chip);
  }

  const plannedEventFor = (chip: Chip, half: "first" | "second"): number | null => {
    const plan = plannedChips.find(p => p.chip === chip);
    if (!plan) return null;
    const planHalf: "first" | "second" = plan.event <= halfBoundary ? "first" : "second";
    return planHalf === half ? plan.event : null;
  };

  const remaining: ChipInventoryEntry[] = [];
  const expiredUnused: ChipInventoryEntry[] = [];
  for (const chip of ALL_CHIPS) {
    if (!usedFirst.has(chip)) (firstHalfClosed ? expiredUnused : remaining).push({ chip, half: "first", plannedEvent: firstHalfClosed ? null : plannedEventFor(chip, "first") });
    if (!usedSecond.has(chip)) (secondHalfClosed ? expiredUnused : remaining).push({ chip, half: "second", plannedEvent: secondHalfClosed ? null : plannedEventFor(chip, "second") });
  }

  return { status: "available", halfBoundary, remaining, expiredUnused };
}

// Storage shape for "which chip am I planning to play, and for which future gameweek" -- the ONE
// unified model the portfolio inventory above, the captain picker's pre-deadline multiplier
// preview, and the Wildcard/Free Hit planning surface all read and write, so none of them can
// silently disagree with each other about the same chip. At most one row per chip name: planning a
// chip again for a different week replaces the old row rather than adding a second one -- that
// chip's OTHER, already-used real instance (its other half) lives in historyChips, not here, so
// this store never needs two rows for one chip name to represent both halves at once.
export type PlannedChip = Readonly<{ event: number; chip: Chip }>;

const PLANNED_CHIPS_STORAGE_KEY = "fpl-edge-planned-chips";

export function readPlannedChips(): readonly PlannedChip[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PLANNED_CHIPS_STORAGE_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** Drop-in write path -- goes through persist() so the existing 800ms-debounced background sync
 * (see persistence.ts) picks it up automatically, no new sync mechanism, same as writePlans(). */
export function writePlannedChips(plannedChips: readonly PlannedChip[]): void {
  persist(PLANNED_CHIPS_STORAGE_KEY, JSON.stringify(plannedChips));
}

// Every forward-projection call site (Overview, Final Check, transfers.ts, transfer-routes.ts) and
// the Gameweek Navigator's future-week badge all resolve "what's planned for THIS event" through
// this one function, keyed strictly on eventId -- the off-by-one risk this project keeps guarding
// against (see the chip-inventory boundary tests) is a call site accidentally reading a different
// event's plan, not this function's own logic, which is intentionally this small.
export function plannedChipFor(plannedChips: readonly PlannedChip[], eventId: number): Chip | null {
  return plannedChips.find(p => p.event === eventId)?.chip ?? null;
}

export type PlanChipResult =
  | { ok: true; plannedChips: readonly PlannedChip[] }
  | { ok: false; reason: string };

/**
 * Enforces the real one-chip-per-gameweek rule against a write: planning a chip for a gameweek
 * that already holds a DIFFERENT planned chip is rejected with a reason the caller shows directly,
 * never silently overwritten and never silently ignored. Planning the SAME chip again (e.g.
 * updating which week it targets) always succeeds via upsert-by-chip-name.
 */
export function planChip(existing: readonly PlannedChip[], next: PlannedChip): PlanChipResult {
  const conflict = existing.find(p => p.event === next.event && p.chip !== next.chip);
  if (conflict) return { ok: false, reason: `Gameweek ${next.event} already has ${conflict.chip} planned -- remove it first.` };
  return { ok: true, plannedChips: [...existing.filter(p => p.chip !== next.chip), next] };
}

export function removePlannedChip(existing: readonly PlannedChip[], chip: Chip): readonly PlannedChip[] {
  return existing.filter(p => p.chip !== chip);
}

export type ChipPortfolioCandidate = Readonly<{
  event: FplEvent;
  wildcard: ChipScore;
  freeHit: ChipScore;
  benchBoost: ChipScore;
  tripleCaptain: ChipScore;
}>;

// planned is optional so optimizeChipSchedule's own object literals below stay untouched (they
// never set it, which reads as falsy) -- only scheduleChipsWithPlans, its wrapper, sets it
// explicitly, to distinguish a locked-in plan from a mere suggestion in the UI.
export type ChipAssignment = Readonly<{ chip: Chip; event: FplEvent; score: number; detail: string; planned?: boolean }>;

function scoreFor(row: ChipPortfolioCandidate, chip: Chip): ChipScore {
  return chip === "Wildcard" ? row.wildcard : chip === "Free Hit" ? row.freeHit : chip === "Bench Boost" ? row.benchBoost : row.tripleCaptain;
}

/**
 * Exhaustive assignment of `chips` (expected: at most 4, one half's remaining chips) to distinct
 * weeks from `candidates` (expected: at most ~19, one half's still-actionable weeks), maximizing
 * total score under a strict one-chip-per-week constraint. Real worst case P(19,4)=93,024 full
 * assignments (fewer once the "skip" branch below prunes early), each candidate just summing
 * already-computed ChipScore.score numbers -- no shortlist prefilter or heuristic/annealing search
 * needed. This is smaller in raw combination count, and each candidate is vastly cheaper to score,
 * than optimizer.ts's own simulated-annealing optimize() (24 restarts x 520 steps = 12,480 full
 * squad evaluate() calls) -- reaching for that machinery here would be solving a small, discrete,
 * fully-enumerable problem with a tool built for a much larger one.
 *
 * A chip with no legal remaining week (more chips than candidates) is simply omitted from the
 * result rather than forcing an invalid assignment or returning nothing at all -- every ChipScore
 * is >=1 (see LiveIntelligence.tsx's clamp()), so placing a chip in any available week always beats
 * leaving it unplaced, and the search naturally fills as many chip/week slots as legally fit.
 */
export function optimizeChipSchedule(chips: readonly Chip[], candidates: readonly ChipPortfolioCandidate[]): readonly ChipAssignment[] {
  if (!chips.length || !candidates.length) return [];
  const bestHolder: { total: number; assignment: ChipAssignment[] }[] = [];
  const usedRows = new Set<number>();
  const current: ChipAssignment[] = [];

  function recordIfBest(total: number): void {
    if (!bestHolder.length || total > bestHolder[0].total) bestHolder[0] = { total, assignment: [...current] };
  }

  function recurse(chipIndex: number, runningTotal: number): void {
    if (chipIndex === chips.length) {
      recordIfBest(runningTotal);
      return;
    }
    // Skip branch: leave this chip unplaced. Always recorded as a candidate outcome so a chip with
    // no legal remaining week still yields the best possible assignment of the others, rather than
    // the whole search coming back empty.
    recurse(chipIndex + 1, runningTotal);
    const chip = chips[chipIndex];
    for (let i = 0; i < candidates.length; i++) {
      if (usedRows.has(i)) continue;
      const row = candidates[i];
      const { score, detail } = scoreFor(row, chip);
      usedRows.add(i);
      current.push({ chip, event: row.event, score, detail });
      recurse(chipIndex + 1, runningTotal + score);
      current.pop();
      usedRows.delete(i);
    }
  }
  recurse(0, 0);
  return bestHolder.length ? [...bestHolder[0].assignment].sort((a, b) => a.event.id - b.event.id) : [];
}

/**
 * Wraps optimizeChipSchedule (unchanged above, still the exact mutation-tested search) rather than
 * modifying it: a chip with a real PlannedChip entry is pinned to that week -- taken out of the
 * free search entirely and returned as a fixed row -- and its week is removed from the candidate
 * pool so no OTHER remaining chip can be double-booked onto it (the real one-chip-per-gameweek
 * rule). optimizeChipSchedule then runs its normal search on whatever chips/candidates are left.
 * A plan whose event no longer appears in `candidates` (stale: already passed, or fell out of the
 * projected horizon) is treated as if it didn't exist for pinning purposes -- the chip just goes
 * back into the free search, not a crash and not a forced invalid assignment.
 */
export function scheduleChipsWithPlans(chips: readonly Chip[], candidates: readonly ChipPortfolioCandidate[], plannedChips: readonly PlannedChip[]): readonly ChipAssignment[] {
  const pinned: ChipAssignment[] = [];
  const reservedEventIds = new Set<number>();
  const unplannedChips: Chip[] = [];
  for (const chip of chips) {
    const plan = plannedChips.find(p => p.chip === chip);
    const row = plan && candidates.find(c => c.event.id === plan.event);
    if (plan && row) {
      const { score, detail } = scoreFor(row, chip);
      pinned.push({ chip, event: row.event, score, detail, planned: true });
      reservedEventIds.add(row.event.id);
    } else {
      unplannedChips.push(chip);
    }
  }
  const freeCandidates = candidates.filter(c => !reservedEventIds.has(c.event.id));
  const optimized = optimizeChipSchedule(unplannedChips, freeCandidates).map(assignment => ({ ...assignment, planned: false }));
  return [...pinned, ...optimized].sort((a, b) => a.event.id - b.event.id);
}
