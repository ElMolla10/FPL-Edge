/**
 * Client-safe chip / unlimited-transfer detection.
 *
 * Official FPL signals (prefer in this order):
 * 1. Authenticated my-team `chips[]` with `status_for_entry === "active"`
 * 2. Public/live `active_chip` / manager.chip (`"wildcard"` / `"freehit"`)
 * 3. Live my-team `transfers.limit === null` (WC or FH unlimited window — identity
 *    still needs 1 or 2 to distinguish Wildcard vs Free Hit)
 *
 * Pure helpers only — safe for `"use client"` imports.
 */

export type OfficialChipName = "wildcard" | "freehit" | "bboost" | "3xc" | string;

export type MyTeamChip = Readonly<{
  name?: string | null;
  status_for_entry?: string | null;
  number?: number | null;
  played_by_entry?: readonly number[] | null;
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

export function activeChipFromMyTeamChips(chips: readonly MyTeamChip[] | null | undefined): OfficialChipName | null {
  if (!Array.isArray(chips) || !chips.length) return null;
  const active = chips.find((chip) => String(chip.status_for_entry ?? "").toLowerCase() === "active");
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
  if (name === "freehit" || name === "fh" || name === "freehit") return "freehit";
  if (name === "bboost" || name === "benchboost") return "bboost";
  if (name === "3xc" || name === "triplecaptain") return "3xc";
  return name;
}

export type WildcardDetectionInput = {
  /** my-team chips[].status_for_entry === "active" name, or event picks active_chip */
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
