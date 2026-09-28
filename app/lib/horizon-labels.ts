import type { HorizonMode } from "./optimizer";

/**
 * Internal HorizonMode id "GW1 Attack" means "next-GW attack" and stays stable for saved plans.
 * Never show raw "GW1 Attack" in user-facing UI when the live next GW is not 1 — always map via
 * horizonModeLabel → `GW{n} Attack` (or "Next GW Attack" when id unknown).
 */
export function horizonModeLabel(mode: HorizonMode, nextGwId: number | null | undefined): string {
  if (mode === "GW1 Attack") {
    const gw = typeof nextGwId === "number" && nextGwId > 0 ? nextGwId : null;
    return gw ? `GW${gw} Attack` : "Next GW Attack";
  }
  return mode;
}

export function immediateGwGapLabel(nextGwId: number | null | undefined): string {
  const gw = typeof nextGwId === "number" && nextGwId > 0 ? nextGwId : null;
  return gw ? `GW${gw} gap` : "next-GW gap";
}
