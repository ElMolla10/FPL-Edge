// Feature #10 v1 (Interactive FPL Coach): every function here is pure interpolation, never
// generation. Each parameter type is the REAL, already-exported result type of an existing,
// tested engine (CaptainCandidate, Transfer, PriceRiskAlert, ChipScore, DifferentialEntry,
// LiveScoringResult, LiveMover) -- never a redefined or looser shape. A narration function can
// only read fields that already exist on a real computed result; it cannot invent a claim, a
// number, or a caveat that didn't come out of a tool call, because there is nothing else in scope
// to read from. See tests/coach-narration.test.mts for the interpolation-not-generation proof on
// every function below: a constructed real-shaped input with a known number, asserting that exact
// number appears in the output.

import type { Chip, ChipScore } from "../components/LiveIntelligence";
import type { CaptaincyRiskFraming, CaptainCandidate, LiveScoringResult } from "../components/CoachApp";
import type { LiveMover } from "./fpl";
import type { Transfer } from "./transfers";
import type { PriceRiskAlert } from "../components/CoachApp";
import type { DifferentialEntry } from "./ownership-radar";
import type { WeekPlan } from "./optimizer";
import type { ManagerMeta } from "./squad-comparison";
import type { ChipInventoryResult } from "./chip-portfolio";

export function narrateCaptainChoice(chosen: CaptainCandidate, current: CaptainCandidate, framing: CaptaincyRiskFraming): string {
  if (chosen.id === current.id) {
    const roleLine = framing.defaultRole === "safe" ? "It's both your model pick and the safest option in your XI this week."
      : framing.defaultRole === "differential" ? "It's both your model pick and the highest-ceiling differential in your XI this week."
      : "It's a balanced pick -- not the safest floor or the highest ceiling in your XI, just the highest projected points.";
    return `${chosen.name} is already your resolved captain. ${roleLine}`;
  }
  const comparison = `${chosen.name} projects ${chosen.xPts.toFixed(1)} xPts (${chosen.startProbability.toFixed(0)}% start, ${chosen.selectedBy.toFixed(1)}% owned) vs ${current.name}'s ${current.xPts.toFixed(1)} xPts (${current.startProbability.toFixed(0)}% start, ${current.selectedBy.toFixed(1)}% owned).`;
  if (framing.safeAlternative?.id === chosen.id) return `${comparison} ${chosen.name} is your model's real safe alternative to ${current.name} this week.`;
  if (framing.differentialAlternative?.id === chosen.id) return `${comparison} ${chosen.name} is your model's real highest-ceiling differential alternative to ${current.name} this week.`;
  return comparison;
}

export function narratePrimaryTransfer(move: Transfer | null): string {
  if (!move) return "No risk-adjusted squad move clears the action threshold this week -- rolling your transfer is the model's real recommendation.";
  return `${move.out.name} → ${move.incoming.name}: +${move.gain5.toFixed(1)} projected squad points across five gameweeks, ${move.minutes >= 0 ? `${Math.round(move.minutes)} extra expected minutes this week` : "fixture-led upside despite lower expected minutes"}, ${move.risk} modelled minutes/availability risk.`;
}

export function narrateTransferForPlayer(match: Transfer | undefined, rank: number | null, limit: number, playerName: string): string {
  if (!match || rank === null) return `${playerName} isn't among your top-${limit} ranked transfer options right now.`;
  return `${playerName} ranks #${rank} of your top-${limit} transfer options: +${match.gain5.toFixed(1)} projected squad points across five gameweeks vs ${match.out.name}, ${match.risk} modelled minutes/availability risk.`;
}

export function narratePriceRisk(alert: PriceRiskAlert | undefined, playerName: string): string {
  if (!alert) return `${playerName} isn't currently flagged for price-fall risk.`;
  return `${playerName} ${alert.message}`;
}

// Coach-specific policy, deliberately NOT shared with LiveDraftBuilder.tsx's own similar-shaped
// isLegal check: that one defaults permissive (legal:true) when the inventory is unavailable
// (Draft Lab isn't necessarily connected, so it stays optimistic). Coach's honest-answer
// requirement is the opposite -- if legality genuinely can't be determined, the right response is
// to say so, not to silently assume legal. Extracted as its own pure function specifically so this
// classification has direct test coverage, not left as untested inline logic (rule 7).
export function resolveChipLegality(inventory: ChipInventoryResult, chip: Chip, eventId: number): { legal: boolean; expired: boolean; reason: string | null } {
  if (inventory.status !== "available") return { legal: false, expired: false, reason: inventory.reason };
  const legalHalf: "first" | "second" = eventId <= inventory.halfBoundary ? "first" : "second";
  const legal = inventory.remaining.some(e => e.chip === chip && e.half === legalHalf);
  const expired = inventory.expiredUnused.some(e => e.chip === chip);
  return { legal, expired, reason: null };
}

export function narrateChipDecision(chip: Chip, legality: { legal: boolean; expired: boolean; reason: string | null }, eventName: string, score: ChipScore | null): string {
  if (legality.reason) return legality.reason;
  if (!legality.legal) {
    return legality.expired
      ? `${chip} isn't available for ${eventName} -- your window to use it in that half of the season has already closed, unused.`
      : `${chip} isn't legal for ${eventName} -- it's already accounted for elsewhere this half of the season.`;
  }
  if (!score) return `${chip} is legal for ${eventName}, but a scored recommendation isn't available right now.`;
  return `${chip} is legal for ${eventName}. ${score.detail} (${score.score}/10)`;
}

export function narrateDifferentials(positionName: string, entries: readonly DifferentialEntry[]): string {
  if (!entries.length) return `No real candidates were found for ${positionName} right now.`;
  const lines = entries.map(({ player, xPts5 }) => `${player.name} (${player.selectedBy.toFixed(1)}% owned, ${xPts5.toFixed(1)} 5-GW xPts)`);
  return `Top ${positionName} differentials right now: ${lines.join("; ")}.`;
}

export function narrateLiveStatus(scoring: LiveScoringResult, movers: { hurting: readonly LiveMover[]; helping: readonly LiveMover[] }, eventName: string): string {
  const chipNote = scoring.activeChip ? ` (${scoring.activeChip} active, ×${scoring.captainMultiplier} captain multiplier)` : "";
  const swapNote = scoring.swaps.length ? ` ${scoring.swaps.length} autosub${scoring.swaps.length === 1 ? "" : "s"} applied: ${scoring.swaps.map(s => `${s.outName} → ${s.inName}`).join(", ")}.` : "";
  const helpLine = movers.helping.length ? ` Helping: ${movers.helping.map(m => `${m.player.name} (+${m.delta.toFixed(1)} vs projected)`).join(", ")}.` : "";
  const hurtLine = movers.hurting.length ? ` Hurting: ${movers.hurting.map(m => `${m.player.name} (${m.delta.toFixed(1)} vs projected)`).join(", ")}.` : "";
  return `${eventName} live total: ${scoring.liveTotal.toFixed(1)} points${chipNote}.${swapNote}${helpLine}${hurtLine}`;
}

export function narrateCurrentRank(meta: ManagerMeta): string {
  return `${meta.teamName}'s real current overall rank is ${meta.overallRank.toLocaleString()}, with ${meta.overallPoints} total points -- this is your official current standing, not a forward projection.`;
}

export function narrateSquadBuild(week: WeekPlan, horizonMode: string): string {
  return `The ${horizonMode} build uses a ${week.formation} formation, captained by ${week.captain.name}, projecting ${week.points.toFixed(1)} points this gameweek.`;
}
