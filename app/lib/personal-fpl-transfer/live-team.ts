/**
 * Live transfer-state overlay from authenticated FPL `GET /api/my-team/{entry}/`.
 *
 * Public `entry_history.bank` / `last_deadline_bank` freeze at the last deadline.
 * After the manager places pending transfers for the *next* gameweek, ITB and the
 * 15-man squad diverge — ranking must use my-team `transfers.bank` (tenths) and
 * live picks, or Actionable rows stay affordable against stale £ITB.
 */

import type { MyTeamResponse } from "./client";
import { createRotatingTokenProvider, fetchMyTeam } from "./client";
import { personalFplEntryId, type PersonalTransferEnv } from "./config";
import { FplOidcError } from "./oidc";
import {
  casPersistPersonalAuthSession,
  claimRefreshLease,
  clearRefreshLease,
  loadPersonalAuthSession,
  persistPersonalAuthSession,
  reloadPersonalAuthSessionFromDb,
  tryAdoptEnvSeedRefreshToken,
} from "./store";

export type LiveTeamFinance = {
  bankMillions: number;
  squadValueMillions: number;
  transfersMade: number;
  transferCost: number;
  freeTransferLimit: number | null;
  playerIds: number[];
  /** Official selling prices in £m keyed by element id. */
  sellingMillionsById: Map<number, number>;
  picks: Array<{
    elementId: number;
    position: number;
    multiplier: number;
    isCaptain: boolean;
    isViceCaptain: boolean;
    sellingPrice: number;
  }>;
  source: "live-my-team";
};

/** Metric-safe reasons — never include token material. */
export type LiveOverlayError =
  | "missing-entry-config"
  | "missing-refresh-token"
  | "token-expired"
  | "oidc-failed"
  | "my-team-failed"
  | "invalid-my-team"
  | "unknown";

export type LiveTeamFinanceAttempt =
  | { ok: true; finance: LiveTeamFinance }
  | { ok: false; error: LiveOverlayError | null };

/** Pure merge: prefer live my-team bank/picks when present. */
export function liveTeamFinanceFromMyTeam(myTeam: MyTeamResponse): LiveTeamFinance | null {
  const bankTenths = Number(myTeam.transfers?.bank);
  if (!Number.isFinite(bankTenths) || bankTenths < 0) return null;
  const picks = Array.isArray(myTeam.picks) ? myTeam.picks : [];
  if (picks.length !== 15) return null;

  const sellingMillionsById = new Map<number, number>();
  const mapped = picks.map((pick) => {
    const elementId = Number(pick.element);
    const sellingTenths = Number(pick.selling_price);
    const sellingPrice = Number.isFinite(sellingTenths) ? Math.round(sellingTenths) / 10 : Number.NaN;
    if (Number.isFinite(sellingPrice) && sellingPrice >= 0) {
      sellingMillionsById.set(elementId, sellingPrice);
    }
    return {
      elementId,
      position: Number(pick.position) || 0,
      multiplier: Number(pick.multiplier) || 0,
      isCaptain: Boolean(pick.is_captain),
      isViceCaptain: Boolean(pick.is_vice_captain),
      sellingPrice: Number.isFinite(sellingPrice) ? sellingPrice : 0,
    };
  });

  if (mapped.some((pick) => !Number.isFinite(pick.elementId) || pick.elementId <= 0)) return null;
  // Prefer full official selling map; still overlay bank/ids when a few prices are missing
  // (public path derives the rest). Previously requiring size===15 dropped valid live banks.

  const valueTenths = Number(myTeam.transfers?.value);
  const made = Number(myTeam.transfers?.made);
  const cost = Number(myTeam.transfers?.cost);
  const limitRaw = myTeam.transfers?.limit;
  const limit = limitRaw === null || limitRaw === undefined ? null : Number(limitRaw);

  return {
    bankMillions: Math.round(bankTenths) / 10,
    squadValueMillions: Number.isFinite(valueTenths) ? Math.round(valueTenths) / 10 : 0,
    transfersMade: Number.isFinite(made) ? made : 0,
    transferCost: Number.isFinite(cost) ? cost : 0,
    freeTransferLimit: limit !== null && Number.isFinite(limit) ? limit : null,
    playerIds: mapped.map((pick) => pick.elementId),
    sellingMillionsById,
    picks: mapped,
    source: "live-my-team",
  };
}

function classifyOverlayError(error: unknown): LiveOverlayError {
  if (error instanceof FplOidcError) {
    if (error.isInvalidGrant) return "token-expired";
    return "oidc-failed";
  }
  if (error instanceof Error) {
    const message = error.message;
    if (/invalid_grant|expired|revoked/i.test(message)) return "token-expired";
    if (/OIDC|oidc|token/i.test(message)) return "oidc-failed";
    if (/my-team failed:\s*(401|403)/i.test(message)) return "token-expired";
    if (/my-team failed/i.test(message)) return "my-team-failed";
  }
  return "unknown";
}

/**
 * When the requested entry is the personal team and a refresh token is
 * configured, fetch my-team. Read overlay does not require the transfer
 * kill-switch (EXEC) — that gate stays on place/execute only.
 *
 * Returns `{ ok:false, error:null }` when this entry is not the personal team
 * (public path; no error to surface).
 */
export async function tryFetchLiveTeamFinance(
  entryId: string,
  env: PersonalTransferEnv,
): Promise<LiveTeamFinanceAttempt> {
  const personalEntry = personalFplEntryId(env);
  if (!personalEntry) {
    // Only surface missing config when the caller asked for a plausible personal id
    // and secrets are partially set — otherwise stay quiet for arbitrary public entries.
    return { ok: false, error: null };
  }
  if (personalEntry !== entryId) {
    return { ok: false, error: null };
  }

  try {
    const session = await loadPersonalAuthSession(env);
    if (!session) {
      console.warn("[fpl-live-overlay] missing-refresh-token");
      return { ok: false, error: "missing-refresh-token" };
    }

    const tokens = await createRotatingTokenProvider(session, {
      persistSession: casPersistPersonalAuthSession,
      reloadSession: reloadPersonalAuthSessionFromDb,
      adoptEnvSeed: (failed) => tryAdoptEnvSeedRefreshToken(env, failed),
      claimRefreshLease: (expected) => claimRefreshLease(expected),
      clearRefreshLease: (expected) => clearRefreshLease(expected),
      forcePersistSession: (next) => persistPersonalAuthSession(next),
    });
    const myTeam = await fetchMyTeam(personalEntry, tokens);
    const finance = liveTeamFinanceFromMyTeam(myTeam);
    if (!finance) {
      console.warn("[fpl-live-overlay] invalid-my-team");
      return { ok: false, error: "invalid-my-team" };
    }
    return { ok: true, finance };
  } catch (error) {
    const reason = classifyOverlayError(error);
    console.warn(`[fpl-live-overlay] ${reason}`);
    return { ok: false, error: reason };
  }
}


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

export type TransferBankSource = "live-my-team" | "entry-history" | "unavailable" | null;

/**
 * Choose bank for affordability: live my-team wins over deadline/history whenever
 * both are known (they diverge after pending next-GW transfers).
 *
 * When `disallowHistoryFallback` is set (personal entry live overlay failed), never
 * treat public entry-history bank as authoritative for Transfers rankings.
 */
export function resolveTransferBankMillions(options: {
  historyBankMillions: number | null | undefined;
  liveBankMillions: number | null | undefined;
  /** Personal entry + live my-team failed — ranking must not use £history. */
  disallowHistoryFallback?: boolean;
}): { bank: number | null; source: TransferBankSource } {
  const live = options.liveBankMillions;
  if (typeof live === "number" && Number.isFinite(live) && live >= 0) {
    return { bank: Math.round(live * 10) / 10, source: "live-my-team" };
  }
  if (options.disallowHistoryFallback) {
    return { bank: null, source: "unavailable" };
  }
  const history = options.historyBankMillions;
  if (typeof history === "number" && Number.isFinite(history) && history >= 0) {
    return { bank: Math.round(history * 10) / 10, source: "entry-history" };
  }
  return { bank: null, source: null };
}
