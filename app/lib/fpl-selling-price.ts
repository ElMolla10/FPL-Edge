/**
 * Official FPL selling-price arithmetic (integer tenths of a million).
 *
 * When a player's price has risen since purchase, only half the rise
 * (floored) is kept on sale. Full drops are lost immediately:
 *   rises >= 0  →  purchase + floor(rises / 2)
 *   rises <  0  →  now_cost
 *
 * Public entry picks omit `selling_price`. Prefer authenticated my-team
 * values when available; otherwise derive purchase from transfer history
 * (`element_in_cost`) or season-start (now - cost_change_start) and apply
 * this formula. When purchase is still unknown, never invent proceeds above
 * a safe bound — prefer understating sale value so unaffordable moves cannot
 * mark ACTIONABLE.
 */

export type FplTransferLeg = {
  element_in: number;
  element_in_cost: number;
  element_out: number;
  element_out_cost: number;
  event?: number;
  time?: string;
};

/** Selling price in FPL tenths (e.g. 61 = £6.1m). */
export function fplSellingPriceTenths(purchaseTenths: number, nowCostTenths: number): number {
  const purchase = Math.trunc(purchaseTenths);
  const now = Math.trunc(nowCostTenths);
  if (!Number.isFinite(purchase) || !Number.isFinite(now) || purchase < 0 || now < 0) {
    // Unknown inputs: refuse to invent proceeds — caller should treat as missing.
    return Number.NaN;
  }
  const rises = now - purchase;
  if (rises >= 0) return purchase + Math.floor(rises / 2);
  return now;
}

/** Selling price in £m (one decimal), same rounding as the rest of the app. */
export function fplSellingPriceMillions(purchaseMillions: number, nowCostMillions: number): number {
  const purchaseTenths = Math.round(purchaseMillions * 10);
  const nowTenths = Math.round(nowCostMillions * 10);
  const sellTenths = fplSellingPriceTenths(purchaseTenths, nowTenths);
  if (!Number.isFinite(sellTenths)) return Number.NaN;
  return Math.round(sellTenths) / 10;
}

/**
 * Conservative sale value in £m when we only know current market price and
 * season-to-date change (`cost_change_start` / `priceChangeSinceStart`).
 *
 * Treats implied season-start (now - change) as purchase. That matches
 * never-transferred-in players exactly. For players bought mid-season after
 * rises, it can understate proceeds (safe). For the rare dip-then-buy-then-rise
 * case without transfer history it can slightly overstate — transfer history
 * closes that gap when the team route can fetch it.
 *
 * When change is non-finite, returns NaN so callers do not invent proceeds.
 */
export function conservativeSellingFromSeasonChange(
  nowCostMillions: number,
  priceChangeSinceStartMillions: number,
): number {
  if (!Number.isFinite(nowCostMillions) || !Number.isFinite(priceChangeSinceStartMillions)) {
    return Number.NaN;
  }
  const nowTenths = Math.round(nowCostMillions * 10);
  const changeTenths = Math.round(priceChangeSinceStartMillions * 10);
  const purchaseTenths = nowTenths - changeTenths;
  const sellTenths = fplSellingPriceTenths(purchaseTenths, nowTenths);
  if (!Number.isFinite(sellTenths)) return Number.NaN;
  return Math.round(sellTenths) / 10;
}

/**
 * Latest purchase price (tenths) per element still owned, from public
 * `/api/entry/{id}/transfers/` legs. Chronological overwrite: last buy wins.
 */
export function purchaseTenthsFromTransferHistory(
  transfers: readonly FplTransferLeg[],
  ownedElementIds: ReadonlySet<number>,
): Map<number, number> {
  const purchase = new Map<number, number>();
  const ordered = [...transfers].sort((a, b) => {
    const ta = a.time ? Date.parse(a.time) : 0;
    const tb = b.time ? Date.parse(b.time) : 0;
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    return (a.event ?? 0) - (b.event ?? 0);
  });
  for (const leg of ordered) {
    const id = Number(leg.element_in);
    const cost = Number(leg.element_in_cost);
    if (!ownedElementIds.has(id)) continue;
    if (!Number.isFinite(id) || !Number.isFinite(cost) || cost < 0) continue;
    purchase.set(id, Math.trunc(cost));
  }
  return purchase;
}

/**
 * Build per-element selling prices in £m for an owned squad.
 *
 * Priority per player:
 * 1. Explicit official selling (my-team / picks.selling_price) when finite
 * 2. Transfer-history purchase + now_cost formula
 * 3. Season-start purchase (now - cost_change_start) + formula
 * 4. If still unknown: omit the id (caller must not default to now_cost for
 *    risen players — use a conservative bound or exclude the route)
 */
export function deriveSellingPricesMillions(options: {
  ownedElementIds: readonly number[];
  nowCostTenthsById: ReadonlyMap<number, number>;
  costChangeStartTenthsById?: ReadonlyMap<number, number>;
  transfers?: readonly FplTransferLeg[];
  officialSellingMillionsById?: ReadonlyMap<number, number>;
}): Map<number, number> {
  const owned = new Set(options.ownedElementIds);
  const fromTransfers = purchaseTenthsFromTransferHistory(options.transfers ?? [], owned);
  const selling = new Map<number, number>();

  for (const id of owned) {
    const official = options.officialSellingMillionsById?.get(id);
    if (typeof official === "number" && Number.isFinite(official) && official >= 0) {
      selling.set(id, Math.round(official * 10) / 10);
      continue;
    }

    const nowTenths = options.nowCostTenthsById.get(id);
    if (typeof nowTenths !== "number" || !Number.isFinite(nowTenths) || nowTenths < 0) continue;

    let purchaseTenths = fromTransfers.get(id);
    if (purchaseTenths === undefined) {
      const change = options.costChangeStartTenthsById?.get(id);
      if (typeof change === "number" && Number.isFinite(change)) {
        purchaseTenths = Math.trunc(nowTenths) - Math.trunc(change);
      }
    }
    if (purchaseTenths === undefined || !Number.isFinite(purchaseTenths) || purchaseTenths < 0) {
      // No safe purchase: omit rather than invent now_cost proceeds.
      continue;
    }

    const sellTenths = fplSellingPriceTenths(purchaseTenths, nowTenths);
    if (!Number.isFinite(sellTenths)) continue;
    selling.set(id, Math.round(sellTenths) / 10);
  }

  return selling;
}
