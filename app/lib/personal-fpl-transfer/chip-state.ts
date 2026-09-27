/**
 * Client-safe chip / unlimited-transfer detection.
 *
 * Official FPL signals (prefer in this order):
 * 1. Authenticated my-team `chips[]` where the chip is live for this transfer
 *    window — prefer `is_pending === true` (2025/26 verified my-team shape:
 *    status_for_entry is available|played|unavailable, not "active"). Also
 *    accept legacy `status_for_entry === "active"|"pending"`.
 * 2. Public/live `active_chip` / manager.chip (`"wildcard"` / `"freehit"`)
 * 3. Live my-team `transfers.limit === null` (WC or FH unlimited window — identity
 *    still needs 1 or 2 to distinguish Wildcard vs Free Hit)
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

/**
 * Chip is live for the current transfer/deadline window.
 * 2025/26 my-team uses is_pending; older payloads used status_for_entry "active".
 */
export function isMyTeamChipLiveActive(chip: MyTeamChip | null | undefined): boolean {
  if (!chip) return false;
  if (chip.is_pending === true) return true;
  const status = String(chip.status_for_entry ?? "")
    .trim()
    .toLowerCase();
  return status === "active" || status === "pending";
}

export function activeChipFromMyTeamChips(chips: readonly MyTeamChip[] | null | undefined): OfficialChipName | null {
  if (!Array.isArray(chips) || !chips.length) return null;
  const active = chips.find((chip) => isMyTeamChipLiveActive(chip));
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
 * Prefer live my-team chip; fall back to public event picks.active_chip
 * (OK without personal overlay — already public on entry event picks).
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

export type WildcardDetectionInput = {
  /** my-team chips[].is_pending / status active, or event picks active_chip */
  activeChip?: string | null;
  /** Live my-team transfers.limit (null = unlimited WC/FH window) */
  freeTransferLimit?: number | null;
  /** Only trust limit===null when bank came from live my-team */
  bankSource?: string | null;
  chips?: readonly MyTeamChip[] | null;
};

/**
 * Wildcard is active for the current transfer window.
 * Prefer chips status / active_chip; never treat Free Hit as Wildcard.
 * limit===null alone is insufficient (WC vs FH).
 */
export function isWildcardActive(input: WildcardDetectionInput): boolean {
  const fromChips = activeChipFromMyTeamChips(input.chips);
  if (fromChips === "wildcard") return true;
  if (fromChips === "freehit") return false;

  const chip = normalizeOfficialChip(input.activeChip);
  if (chip === "wildcard") return true;
  if (chip === "freehit") return false;

  return false;
}

/** Free Hit active (temporary 1-GW squad) — unlimited transfers, not WC optimization. */
export function isFreeHitActive(input: WildcardDetectionInput): boolean {
  const fromChips = activeChipFromMyTeamChips(input.chips);
  if (fromChips === "freehit") return true;
  if (fromChips === "wildcard") return false;
  return normalizeOfficialChip(input.activeChip) === "freehit";
}

/** Unlimited transfers this window (WC or FH), from live limit or chip identity. */
export function isUnlimitedTransferWindow(input: WildcardDetectionInput): boolean {
  if (isWildcardActive(input) || isFreeHitActive(input)) return true;
  return input.bankSource === "live-my-team" && isUnlimitedTransferLimit(input.freeTransferLimit);
}
