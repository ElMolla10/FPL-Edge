import { FplData, FplPlayer, isCompleteSquad } from "../fpl";
import { conservativeSellingFromSeasonChange } from "../fpl-selling-price";
import type { TransferEngineRules } from "./rules";
import { DEFAULT_TRANSFER_RULES_2026_27 } from "./rules";

export type LegalityReason =
  | "owned"
  | "unavailable"
  | "position"
  | "club-limit"
  | "budget"
  | "squad-shape"
  | "duplicate-out"
  | "duplicate-in";

export type LegalityResult =
  | { legal: true; sellingPrice: number; bankAfter: number }
  | { legal: false; reason: LegalityReason };

function salePriceFallback(player: FplPlayer): number {
  const derived = conservativeSellingFromSeasonChange(player.price, player.priceChangeSinceStart ?? 0);
  return Number.isFinite(derived) && derived >= 0 ? Math.round(derived * 10) / 10 : player.price;
}

export function sellingPriceFor(
  player: FplPlayer,
  sellingPrices: Map<number, number>,
): number {
  if (sellingPrices.has(player.id)) return sellingPrices.get(player.id)!;
  return salePriceFallback(player);
}

/**
 * Official single-swap legality (same discipline as isPlaceableTransfer):
 * position match, not owned, not unavailable, club limit on rest, selling+bank budget, squad shape.
 */
export function isLegalSingleTransfer(
  data: FplData,
  squad: FplPlayer[],
  out: FplPlayer,
  incoming: FplPlayer,
  bank: number,
  sellingPrices: Map<number, number>,
  rules: TransferEngineRules = DEFAULT_TRANSFER_RULES_2026_27,
): LegalityResult {
  if (incoming.positionId !== out.positionId) return { legal: false, reason: "position" };
  if (squad.some((p) => p.id === incoming.id)) return { legal: false, reason: "owned" };
  if (incoming.status === "u") return { legal: false, reason: "unavailable" };
  const rest = squad.filter((p) => p.id !== out.id);
  const teamLimit = Math.min(rules.teamLimit, data.rules.teamLimit);
  if (rest.filter((p) => p.teamId === incoming.teamId).length >= teamLimit) {
    return { legal: false, reason: "club-limit" };
  }
  const safeBank = Number.isFinite(bank) ? bank : 0;
  const sellingPrice = sellingPriceFor(out, sellingPrices);
  const bankAfter = Math.round((safeBank + sellingPrice - incoming.price + Number.EPSILON) * 10) / 10;
  if (incoming.price > sellingPrice + safeBank + 0.001) return { legal: false, reason: "budget" };
  const next = squad.map((p) => (p.id === out.id ? incoming : p));
  if (!isCompleteSquad(next, data)) return { legal: false, reason: "squad-shape" };
  return { legal: true, sellingPrice, bankAfter };
}

export function isLegalMultiTransfer(
  data: FplData,
  squad: FplPlayer[],
  legs: { out: FplPlayer; incoming: FplPlayer }[],
  bank: number,
  sellingPrices: Map<number, number>,
  rules: TransferEngineRules = DEFAULT_TRANSFER_RULES_2026_27,
): LegalityResult {
  if (legs.length === 0) return { legal: false, reason: "squad-shape" };
  const outIds = new Set(legs.map((l) => l.out.id));
  const inIds = new Set(legs.map((l) => l.incoming.id));
  if (outIds.size !== legs.length) return { legal: false, reason: "duplicate-out" };
  if (inIds.size !== legs.length) return { legal: false, reason: "duplicate-in" };

  let working = [...squad];
  let workingBank = Number.isFinite(bank) ? bank : 0;
  const prices = new Map(sellingPrices);
  let lastSelling = 0;
  let lastBankAfter = workingBank;

  for (const leg of legs) {
    const result = isLegalSingleTransfer(data, working, leg.out, leg.incoming, workingBank, prices, rules);
    if (!result.legal) return result;
    lastSelling = result.sellingPrice;
    lastBankAfter = result.bankAfter;
    working = working.map((p) => (p.id === leg.out.id ? leg.incoming : p));
    workingBank = result.bankAfter;
    prices.delete(leg.out.id);
    prices.set(leg.incoming.id, leg.incoming.price);
  }
  return { legal: true, sellingPrice: lastSelling, bankAfter: lastBankAfter };
}
