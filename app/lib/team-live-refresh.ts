/**
 * Keep local/account manager + squad in sync with `/api/fpl/team`.
 *
 * PR #40 made the API overlay live my-team bank/picks for the personal entry, but
 * Transfers still ranked from `fpl-edge-manager` / `fpl-edge-squad` written at last
 * Connect. Sign-in only hydrates the *account* snapshot via `/api/squad`, which stays
 * stale until someone reconnects. Automatic refresh closes that wire break.
 */

import { isSignedIn, writeAccountTeam } from "./persistence";

export type TeamApiManagerSnapshot = {
  bank?: number | null;
  bankSource?: "live-my-team" | "entry-history" | null;
  picks?: Array<{ elementId: number; sellingPrice?: number | null }>;
  [key: string]: unknown;
};

export type TeamApiResponse = {
  playerIds?: number[];
  manager?: TeamApiManagerSnapshot;
  liveOverlay?: boolean;
  error?: string;
};

function safeParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function sortedIdsEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort((x, y) => x - y);
  const right = [...b].sort((x, y) => x - y);
  return left.every((id, index) => id === right[index]);
}

function pickKey(pick: { elementId: number; sellingPrice?: number | null }): string {
  const price =
    typeof pick.sellingPrice === "number" && Number.isFinite(pick.sellingPrice)
      ? String(pick.sellingPrice)
      : "";
  return `${pick.elementId}:${price}`;
}

/** True when cached squad/manager diverge from a fresh `/api/fpl/team` payload. */
export function cachedTeamDiffersFromApi(playerIds: number[], manager: TeamApiManagerSnapshot): boolean {
  const cachedIds = safeParse<number[]>(localStorage.getItem("fpl-edge-squad"), []);
  if (!sortedIdsEqual(cachedIds, playerIds)) return true;

  const cached = safeParse<TeamApiManagerSnapshot | null>(localStorage.getItem("fpl-edge-manager"), null);
  if (!cached) return true;
  if (cached.bank !== manager.bank) return true;
  if ((cached.bankSource ?? null) !== (manager.bankSource ?? null)) return true;

  const cachedPicks = Array.isArray(cached.picks) ? cached.picks : [];
  const apiPicks = Array.isArray(manager.picks) ? manager.picks : [];
  if (cachedPicks.length !== apiPicks.length) return true;
  const cachedKeys = new Set(cachedPicks.map(pickKey));
  for (const pick of apiPicks) {
    if (!cachedKeys.has(pickKey(pick))) return true;
  }
  return false;
}

/**
 * Replace cache when the API payload differs, and *always* when live overlay /
 * live-my-team bank is present and the cache is not already that snapshot.
 * Prevents ranking on stale public bank (~£2.1) after pending next-GW transfers.
 */
export function shouldReplaceCachedTeam(options: {
  liveOverlay: boolean;
  playerIds: number[];
  manager: TeamApiManagerSnapshot;
}): boolean {
  const differs = cachedTeamDiffersFromApi(options.playerIds, options.manager);
  if (!differs) return false;
  if (options.liveOverlay || options.manager.bankSource === "live-my-team") return true;
  // Public path: still refresh when squad/bank changed after a deadline.
  return true;
}

let lastRefreshAt = 0;
let lastRefreshEntry = "";
const REFRESH_COOLDOWN_MS = 45_000;

export type RefreshConnectedTeamResult =
  | { updated: true }
  | { updated: false; skipped: string };

/**
 * When signed in with a linked entry, re-fetch `/api/fpl/team` and replace
 * localStorage + account squad/manager if the live (or public) snapshot differs.
 */
export async function refreshConnectedTeamFromApi(
  data: { players: ReadonlyArray<{ id: number }> },
  options: { force?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<RefreshConnectedTeamResult> {
  if (!isSignedIn()) return { updated: false, skipped: "signed-out" };
  const entry = localStorage.getItem("fpl-edge-entry")?.trim() ?? "";
  if (!entry || !/^\d+$/.test(entry)) return { updated: false, skipped: "no-entry" };

  const now = Date.now();
  if (
    !options.force &&
    lastRefreshEntry === entry &&
    now - lastRefreshAt < REFRESH_COOLDOWN_MS
  ) {
    return { updated: false, skipped: "cooldown" };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let json: TeamApiResponse;
  try {
    const response = await fetchImpl(`/api/fpl/team?entry=${entry}`, { cache: "no-store" });
    json = (await response.json()) as TeamApiResponse;
    if (!response.ok) return { updated: false, skipped: json.error || "team-api-error" };
  } catch {
    return { updated: false, skipped: "team-api-error" };
  }

  const playerIds = Array.isArray(json.playerIds) ? json.playerIds.map(Number) : [];
  const ids = playerIds.filter((id) => data.players.some((player) => player.id === id));
  if (ids.length !== 15 || !json.manager) {
    return { updated: false, skipped: "incomplete-squad" };
  }

  lastRefreshAt = now;
  lastRefreshEntry = entry;

  const liveOverlay = Boolean(json.liveOverlay);
  if (!shouldReplaceCachedTeam({ liveOverlay, playerIds: ids, manager: json.manager })) {
    return { updated: false, skipped: "unchanged" };
  }

  const saved = await writeAccountTeam({
    squadIds: ids,
    entry,
    manager: json.manager,
  });
  if (!saved.ok) return { updated: false, skipped: saved.error };

  return { updated: true };
}

/** Test helper: reset cooldown between cases. */
export function resetTeamLiveRefreshCooldown() {
  lastRefreshAt = 0;
  lastRefreshEntry = "";
}
