// Display-only vocabulary for the weekly call. The transfer engine keeps its own states
// (MAKE / LEAN / HOLD / KEEP / ROLL / WATCH / AVOID) and every analytics key, test and model rule
// continues to use them. The brand identity shows three plain words to the user:
//
//   engine state                      badge   why
//   MAKE (a move clears the bar)      MAKE    do it
//   LEAN (a move edges the hold)      WATCH   marginal: shown as the candidate, not a full recommendation
//   WATCH                             WATCH   same
//   HOLD / KEEP / ROLL / AVOID        KEEP    no transfer this week (Wildcard "KEEP" included)
//
// Nothing here changes ranking, classification or NET maths.

export type DecisionBadgeText = "MAKE" | "KEEP" | "WATCH";
export type DecisionBadgeTone = "make" | "keep" | "watch";

export type DecisionBadge = { text: DecisionBadgeText; tone: DecisionBadgeTone; meaning: string };

export function decisionBadge(action: "MAKE" | "HOLD", classification?: string | null): DecisionBadge {
  if (action === "HOLD") return { text: "KEEP", tone: "keep", meaning: "No transfer clears the bar this week." };
  const c = String(classification ?? "MAKE").toUpperCase();
  if (c === "LEAN" || c === "WATCH") return { text: "WATCH", tone: "watch", meaning: "A marginal edge: worth reviewing, not a clear win." };
  if (c === "HOLD" || c === "KEEP" || c === "ROLL" || c === "AVOID") return { text: "KEEP", tone: "keep", meaning: "No transfer clears the bar this week." };
  return { text: "MAKE", tone: "make", meaning: "This move clears the bar against keeping your squad." };
}

/** Engine confidence (0–1 evidence strength) shown as a plain word beside the real percentage. */
export function confidenceBand(confidence: number | null | undefined): "High" | "Medium" | "Low" | null {
  if (confidence == null || !Number.isFinite(confidence)) return null;
  return confidence >= 0.75 ? "High" : confidence >= 0.5 ? "Medium" : "Low";
}

export function signedPoints(n: number): string {
  const v = Math.round(n * 10) / 10;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;
}
