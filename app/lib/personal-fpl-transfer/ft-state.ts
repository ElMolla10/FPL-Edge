/**
 * Client-safe free-transfer math.
 *
 * Pure helpers only — no D1 / `cloudflare:workers` / OIDC / store imports.
 * CoachApp and other `"use client"` modules must import from this file (or a
 * similarly client-safe path), never from `./index` / `./live-team` / `./store`,
 * which pull the Workers DB binding into the Vite client graph.
 */

/**
 * Remaining free transfers for the *next* additional transfer this GW.
 * Official my-team: `transfers.limit` is the FT allotment (incl. banked);
 * `transfers.made` is already confirmed this GW. Remaining = max(0, limit − made).
 * `limit === null` means an unlimited chip (WC/FH) — treat as fully free for hit math.
 * Returns null when live limit is unknown (caller should fall back to manual FT).
 */
export function remainingFreeTransfers(options: {
  freeTransferLimit: number | null | undefined;
  transfersMade?: number | null | undefined;
}): number | null {
  const limit = options.freeTransferLimit;
  if (limit === null) {
    // Wildcard / Free Hit: FPL sends limit=null — next transfers are free.
    return 5;
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
