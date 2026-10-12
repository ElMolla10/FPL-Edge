/**
 * Client-safe chip / unlimited-transfer detection.
 *
 * Official FPL signals for the *open transfer window* (the next deadline that
 * has not passed), in order:
 * 1. Authenticated my-team `chips[]` armed for that window — `is_pending === true`
 *    (2025/26 status_for_entry is available|played|unavailable). Legacy payloads
 *    used status "active"|"pending". `is_pending === false` is not armed, even
 *    when status is still "active". A chip whose `played_by_entry` lists only
 *    an earlier gameweek is not armed.
 * 2. Public `entry/{id}/history/` `chips[]` whose `event` is the open gameweek.
 *    History is written when the chip is confirmed, before that gameweek's
 *    picks are public.
 * 3. Public event picks `active_chip` only when those picks belong to the open
 *    gameweek. Picks for a previous gameweek stay published after its deadline
 *    with the chip that already locked. That chip must not enable Wildcard mode.
 *
 * `manager.chip` is the chip on the latest *published* picks (live scoring for
 * Bench Boost / Triple Captain). Transfers reads `transferWindowChip` instead.
 * `transfers.limit === null` marks an unlimited window but does not say which chip.
 *
 * Pure helpers only — safe for `"use client"` imports.
 *
 * Activation is on fantasy.premierleague.com; Edge only detects and switches mode.
 */

export type OfficialChipName = "wildcard" | "freehit" | "bboost" | "3xc" | string;

export type MyTeamChip = Readonly<{
  name?: string | null;
  status_for_entry?: string | null;
  number?: number | null;
  played_by_entry?: readonly number[] | null;
  /** True while a transfer/team chip is armed for the open deadline window. */
  is_pending?: boolean | null;
  start_event?: number | null;
  stop_event?: number | null;
  chip_type?: string | null;
}>;

const normalizeChip = (raw: string | null | undefined): string =>
  String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

/** True when FPL reports an unlimited transfer window (Wildcard or Free Hit). */
export function isUnlimitedTransferLimit(limit: number | null | undefined): boolean {
  return limit === null;
}

/** True when every recorded play is strictly before the open transfer gameweek. */
function playedOnlyBefore(chip: MyTeamChip, currentEvent: number): boolean {
  const played = chip.played_by_entry;
  if (!Array.isArray(played) || played.length === 0) return false;
  const ids = played.map((event) => Number(event)).filter((event) => Number.isFinite(event));
  if (!ids.length) return false;
  return ids.every((event) => event < currentEvent);
}

/**
 * Chip is armed for the open transfer/deadline window.
 * 2025/26 my-team uses is_pending; older payloads used status_for_entry "active".
 * `is_pending === false` means the chip is not armed, including when status is
 * still "active" for the gameweek it already scored. A play recorded only in
 * an earlier gameweek is not the open window.
 */
export function isMyTeamChipLiveActive(
  chip: MyTeamChip | null | undefined,
  currentEvent?: number | null,
): boolean {
  if (!chip) return false;
  if (chip.is_pending === false) return false;
  if (
    currentEvent != null &&
    Number.isFinite(currentEvent) &&
    playedOnlyBefore(chip, currentEvent) &&
    chip.is_pending !== true
  ) {
    return false;
  }
  if (chip.is_pending === true) return true;
  const status = String(chip.status_for_entry ?? "")
    .trim()
    .toLowerCase();
  return status === "active" || status === "pending";
}

export function activeChipFromMyTeamChips(
  chips: readonly MyTeamChip[] | null | undefined,
  currentEvent?: number | null,
): OfficialChipName | null {
  if (!Array.isArray(chips) || !chips.length) return null;
  const active = chips.find((chip) => isMyTeamChipLiveActive(chip, currentEvent));
  if (!active) return null;
  const name = normalizeChip(active.name);
  if (!name) return null;
  if (name === "wildcard" || name === "wc") return "wildcard";
  if (name === "freehit" || name === "fh") return "freehit";
  if (name === "bboost" || name === "benchboost") return "bboost";
  if (name === "3xc" || name === "triplecaptain") return "3xc";
  return name;
}

export function normalizeOfficialChip(raw: string | null | undefined): OfficialChipName | null {
  const name = normalizeChip(raw);
  if (!name) return null;
  if (name === "wildcard" || name === "wc") return "wildcard";
  if (name === "freehit" || name === "fh") return "freehit";
  if (name === "bboost" || name === "benchboost") return "bboost";
  if (name === "3xc" || name === "triplecaptain") return "3xc";
  return name;
}

/**
 * Chip shown on the latest published picks (live scoring).
 * Live pending chip wins; otherwise the public picks chip. This is NOT the
 * open transfer window — a previous gameweek's active_chip stays here after
 * the deadline. Transfers must use `resolveTransferWindowChip`.
 */
export function resolveManagerActiveChip(options: {
  liveActiveChip?: string | null;
  publicActiveChip?: string | null;
}): OfficialChipName | null {
  return (
    normalizeOfficialChip(options.liveActiveChip) ??
    normalizeOfficialChip(options.publicActiveChip) ??
    null
  );
}

export type TransferWindowEvent = {
  id: number;
  finished?: boolean;
  /** Bootstrap-static `deadline_time`. */
  deadlineTime?: string | null;
  /** App event shape uses `deadline`. */
  deadline?: string | null;
};

/**
 * Gameweek the manager is transferring for: the earliest event that is not
 * finished and whose deadline is still in the future. The in-play gameweek
 * (`is_current` after its deadline) is not this event.
 */
export function selectOpenTransferEventId(
  events: readonly TransferWindowEvent[] | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!Array.isArray(events) || !events.length) return null;
  let best: number | null = null;
  for (const event of events) {
    if (event.finished) continue;
    const raw = event.deadlineTime ?? event.deadline;
    const deadline = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    if (!Number.isFinite(deadline) || deadline <= nowMs) continue;
    const id = Number(event.id);
    if (!Number.isFinite(id)) continue;
    if (best === null || id < best) best = id;
  }
  return best;
}

/** One row of public `entry/{id}/history/` `chips[]`. */
export type HistoryChipPlay = {
  name?: string | null;
  event?: number | null;
};

/** Chip confirmed for exactly `eventId`, or null. Earlier plays are ignored. */
export function chipPlayedForEvent(
  history: readonly HistoryChipPlay[] | null | undefined,
  eventId: number,
): OfficialChipName | null {
  if (!Array.isArray(history) || !Number.isFinite(eventId)) return null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const row = history[index];
    if (Number(row?.event) !== eventId) continue;
    return normalizeOfficialChip(row?.name);
  }
  return null;
}

export type TransferWindowChipInput = {
  /** Authenticated my-team chips. Authoritative when `liveChipsKnown` and the array is present. */
  liveChips?: readonly MyTeamChip[] | null;
  /** True when my-team was read for this entry. A negative result must not fall back to an older GW. */
  liveChipsKnown?: boolean;
  /** Used only when live chips were read but the raw list was not passed. */
  liveActiveChip?: string | null;
  /** Public history.chips. A play whose event is not `currentEvent` is ignored. */
  chipHistory?: readonly HistoryChipPlay[] | null;
  /** active_chip on a published picks payload. */
  publicActiveChip?: string | null;
  /** Event id of that picks payload. */
  publicChipEvent?: number | null;
  /** Open transfer gameweek from `selectOpenTransferEventId`. */
  currentEvent?: number | null;
};

/**
 * Chip armed for the open deadline. A wildcard (or any chip) used in a
 * previous gameweek returns null for the current gameweek.
 */
export function resolveTransferWindowChip(input: TransferWindowChipInput): OfficialChipName | null {
  const current = input.currentEvent;
  const currentKnown = current != null && Number.isFinite(Number(current));

  if (input.liveChipsKnown) {
    if (Array.isArray(input.liveChips)) {
      return activeChipFromMyTeamChips(input.liveChips, currentKnown ? Number(current) : undefined);
    }
    return normalizeOfficialChip(input.liveActiveChip);
  }

  if (!currentKnown) return null;

  const fromHistory = chipPlayedForEvent(input.chipHistory, Number(current));
  if (fromHistory) return fromHistory;

  // Published picks exist only after that event's deadline. They count for the
  // transfer window only when they are the event still being transferred for.
  if (input.publicChipEvent != null && Number(input.publicChipEvent) === Number(current)) {
    return normalizeOfficialChip(input.publicActiveChip);
  }
  return null;
}

export type WildcardDetectionInput = {
  /** Transfer-window chip, or event picks active_chip when no window was resolved. */
  activeChip?: string | null;
  /** Live my-team transfers.limit (null = unlimited WC/FH window) */
  freeTransferLimit?: number | null;
  /** Only trust limit===null when bank came from live my-team */
  bankSource?: string | null;
  chips?: readonly MyTeamChip[] | null;
  /** Open transfer gameweek. With `chips`, a play from an earlier GW is not active. */
  currentEvent?: number | null;
};

/**
 * Wildcard is armed for the open transfer window.
 * Prefer live chips. A chip played in an earlier gameweek is not active.
 * Never treat Free Hit as Wildcard. limit===null alone is insufficient (WC vs FH).
 */
export function isWildcardActive(input: WildcardDetectionInput): boolean {
  const fromChips = activeChipFromMyTeamChips(input.chips, input.currentEvent);
  if (fromChips === "wildcard") return true;
  if (fromChips === "freehit") return false;

  // Live chips were supplied for a known gameweek and none are armed.
  // Do not let a previous GW's active_chip string turn Wildcard mode back on.
  if (Array.isArray(input.chips) && input.chips.length > 0 && input.currentEvent != null) {
    return false;
  }

  const chip = normalizeOfficialChip(input.activeChip);
  if (chip === "wildcard") return true;
  if (chip === "freehit") return false;

  return false;
}

/** Free Hit active (temporary 1-GW squad) — unlimited transfers, not WC optimization. */
export function isFreeHitActive(input: WildcardDetectionInput): boolean {
  const fromChips = activeChipFromMyTeamChips(input.chips, input.currentEvent);
  if (fromChips === "freehit") return true;
  if (fromChips === "wildcard") return false;
  if (Array.isArray(input.chips) && input.chips.length > 0 && input.currentEvent != null) {
    return false;
  }
  return normalizeOfficialChip(input.activeChip) === "freehit";
}

/** Unlimited transfers this window (WC or FH), from live limit or chip identity. */
export function isUnlimitedTransferWindow(input: WildcardDetectionInput): boolean {
  if (isWildcardActive(input) || isFreeHitActive(input)) return true;
  return input.bankSource === "live-my-team" && isUnlimitedTransferLimit(input.freeTransferLimit);
}
