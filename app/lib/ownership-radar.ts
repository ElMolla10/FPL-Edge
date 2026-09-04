import type { FplFixture, FplPlayer, PositionRule } from "./fpl";
import { playerProjection } from "./fpl";

export type TemplatePosition = Readonly<{ position: PositionRule; players: readonly FplPlayer[] }>;

// Descending real selectedBy%, capped at that position's own real squad-composition count
// (rule.squad -- 2/5/5/3 for GKP/DEF/MID/FWD -- not a picked display number). Tiebreak is id
// ascending, purely for render stability across refreshes: selectedBy is reported to one decimal,
// so exact ties are real and not rare among lower-owned players in the same position.
export function templateByPosition(players: readonly FplPlayer[], positions: readonly PositionRule[]): readonly TemplatePosition[] {
  return positions.map(position => ({
    position,
    players: players
      .filter(p => p.positionId === position.id)
      .sort((a, b) => b.selectedBy - a.selectedBy || a.id - b.id)
      .slice(0, position.squad),
  }));
}

export type DifferentialEntry = Readonly<{ player: FplPlayer; xPts5: number }>;
export type DifferentialPosition = Readonly<{ position: PositionRule; players: readonly DifferentialEntry[] }>;

// Ranked by a combined-rank (Borda-style) sum, not a ratio -- a floored ratio (xPts5/selectedBy)
// was tried first and adversarially disproven: real numbers show ownership (roughly 0-60) and a
// 5-GW xPts total (roughly 0-40) sit on badly mismatched scales, so any direct ratio between them
// is dominated almost entirely by the ownership denominator regardless of the floor chosen -- a
// player at 0.5% owned with a genuinely mediocre projection still massively outranks an 18%-owned
// player with a real, large projection edge (confirmed with real projectionMetrics output: 0.5%
// owned/2.5 xPts scored higher than 18% owned/3.9 xPts). Combined rank avoids the scale mismatch
// entirely: within each position, every player gets a projRank (1 = highest real xPts5) and an
// ownRank (1 = lowest real selectedBy), both pure ordinal positions among that position's own real
// player pool, summed and sorted ascending (lower sum = strong on both axes). No ratio, no floor,
// no invented cutoff value anywhere -- every player's standing is relative only to real peers on
// two real, independently-verifiable axes. Callers get the real xPts5 and read the real selectedBy
// off `player` directly; the rank sum itself is never returned or displayed. Capped at 5 per
// position (Feature #5's existing "top 5 near misses" precedent, not a fresh number).
export function rawDifferentialsByPosition(
  players: readonly FplPlayer[],
  positions: readonly PositionRule[],
  fixtures: FplFixture[],
  eventIds: readonly number[],
): readonly DifferentialPosition[] {
  const firstEvent = eventIds[0];
  return positions.map(position => {
    const scored = players
      .filter(p => p.positionId === position.id)
      .map(player => ({
        player,
        xPts5: firstEvent ? eventIds.reduce((sum, eventId) => sum + playerProjection(player, eventId, fixtures, firstEvent), 0) : 0,
      }));
    const byProjection = [...scored].sort((a, b) => b.xPts5 - a.xPts5 || a.player.id - b.player.id);
    const projRank = new Map(byProjection.map((entry, index) => [entry.player.id, index]));
    const byOwnership = [...scored].sort((a, b) => a.player.selectedBy - b.player.selectedBy || a.player.id - b.player.id);
    const ownRank = new Map(byOwnership.map((entry, index) => [entry.player.id, index]));
    const ranked = scored
      .sort((a, b) => {
        const rankSumA = projRank.get(a.player.id)! + ownRank.get(a.player.id)!;
        const rankSumB = projRank.get(b.player.id)! + ownRank.get(b.player.id)!;
        return rankSumA - rankSumB || a.player.id - b.player.id;
      })
      .slice(0, 5);
    return { position, players: ranked };
  });
}
