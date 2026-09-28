import type { HorizonMode } from "./optimizer";

/** Internal mode ids stay stable (saved plans, tests). UI shows the real next GW number. */
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
