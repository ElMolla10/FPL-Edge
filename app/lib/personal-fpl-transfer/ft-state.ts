/**
 * Client-safe free-transfer math.
 *
 * Pure helpers only — no D1 / `cloudflare:workers` / OIDC / store imports.
 * CoachApp and other `"use client"` modules must import from this file (or a
 * similarly client-safe path), never from `./index` / `./live-team` / `./store`,
 * which pull the Workers DB binding into the Vite client graph.
 *
 * Wildcard / Free Hit: FPL sends `transfers.limit === null`. Do NOT treat that as
 * "5 free transfers" for ranking — callers must detect the chip (see chip-state.ts)
 * and switch to Wildcard Optimization (or FH) rather than normal FT / HOLD / hit math.
 */

import { isUnlimitedTransferLimit } from "./chip-state";

/**
 * Remaining free transfers for the *next* additional transfer this GW.
 * Official my-team: `transfers.limit` is the FT allotment (incl. banked);
 * `transfers.made` is already confirmed this GW. Remaining = max(0, limit − made).
 * `limit === null` means an unlimited chip (WC/FH) — returns null so callers do not
 * invent a finite FT count for normal transfer ranking.
 * Returns null when live limit is unknown OR unlimited (caller must branch on chip).
 */
export function remainingFreeTransfers(options: {
  freeTransferLimit: number | null | undefined;
  transfersMade?: number | null | undefined;
}): number | null {
  const limit = options.freeTransferLimit;
  if (limit === null || isUnlimitedTransferLimit(limit)) {
    // Wildcard / Free Hit: unlimited — not a finite FT count.
    return null;
  }
  if (limit === undefined || !Number.isFinite(limit)) return null;
  const made = Math.max(0, Math.floor(Number(options.transfersMade) || 0));
  return Math.max(0, Math.floor(limit) - made);
}

/** Prefer live remaining FT; otherwise the manual/local fallback (0–5). */
export function resolveAuthoritativeFreeTransfers(options: {
  freeTransferLimit?: number | null;
  transfersMade?: number | null;
  bankSource?: string | null;
  fallbackFreeTransfers: number;
}): number {
  // Unlimited chip window: do not invent FT for the non-WC path. Callers that
  // detect Wildcard must use Wildcard Optimization instead of this number.
  if (
    options.bankSource === "live-my-team" &&
    isUnlimitedTransferLimit(options.freeTransferLimit)
  ) {
    return options.fallbackFreeTransfers;
  }
  const live =
    options.bankSource === "live-my-team"
      ? remainingFreeTransfers({
          freeTransferLimit: options.freeTransferLimit,
          transfersMade: options.transfersMade,
        })
      : null;
  if (live !== null) return Math.max(0, Math.min(5, live));
  const fb = options.fallbackFreeTransfers;
  if (!Number.isFinite(fb)) return 1;
  return Math.max(0, Math.min(5, Math.floor(fb)));
}
