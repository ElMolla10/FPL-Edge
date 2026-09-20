/**
 * Live transfer-state overlay from authenticated FPL `GET /api/my-team/{entry}/`.
 *
 * Public `entry_history.bank` / `last_deadline_bank` freeze at the last deadline.
 * After the manager places pending transfers for the *next* gameweek, ITB and the
 * 15-man squad diverge — ranking must use my-team `transfers.bank` (tenths) and
 * live picks, or Actionable rows stay affordable against stale £ITB.
 */

import type { MyTeamResponse } from "./client";
import {
  createRotatingTokenProvider,
  fetchMyTeam,
} from "./client";
import {
  isPersonalTransferExecEnabled,
  personalFplEntryId,
  type PersonalTransferEnv,
} from "./config";
import { loadPersonalRefreshToken, persistPersonalRefreshToken } from "./store";

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
  if (sellingMillionsById.size !== 15) return null;

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

/**
 * When the requested entry is the personal allowlisted team and a refresh token
 * is configured, fetch my-team. Returns null on any failure (public path still works).
 */
export async function tryFetchLiveTeamFinance(
  entryId: string,
  env: PersonalTransferEnv,
): Promise<LiveTeamFinance | null> {
  if (!isPersonalTransferExecEnabled(env)) return null;
  const personalEntry = personalFplEntryId(env);
  if (!personalEntry || personalEntry !== entryId) return null;

  try {
    const refreshToken = await loadPersonalRefreshToken(env);
    if (!refreshToken) return null;
    const tokens = await createRotatingTokenProvider(refreshToken, persistPersonalRefreshToken);
    const myTeam = await fetchMyTeam(personalEntry, tokens);
    return liveTeamFinanceFromMyTeam(myTeam);
  } catch {
    return null;
  }
}

/**
 * Choose bank for affordability: live my-team wins over deadline/history whenever
 * both are known (they diverge after pending next-GW transfers).
 */
export function resolveTransferBankMillions(options: {
  historyBankMillions: number | null | undefined;
  liveBankMillions: number | null | undefined;
}): { bank: number | null; source: "live-my-team" | "entry-history" | null } {
  const live = options.liveBankMillions;
  if (typeof live === "number" && Number.isFinite(live) && live >= 0) {
    return { bank: Math.round(live * 10) / 10, source: "live-my-team" };
  }
  const history = options.historyBankMillions;
  if (typeof history === "number" && Number.isFinite(history) && history >= 0) {
    return { bank: Math.round(history * 10) / 10, source: "entry-history" };
  }
  return { bank: null, source: null };
}
