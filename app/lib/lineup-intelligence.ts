import type { FplFixture, FplPlayer } from "./fpl";
import { projectionMetrics } from "./fpl";

export type LineupPosition = "GKP" | "DEF" | "MID" | "FWD";
export const LINEUP_POSITIONS: readonly LineupPosition[] = ["GKP", "DEF", "MID", "FWD"];

// Deliberately no formation shape or per-position starting count is derived or asserted anywhere in
// this module -- FPL's own GKP/DEF/MID/FWD categories are coarse (a back-three system's wing-backs
// are still categorised DEF even though they function as wide midfielders), so any inferred "4-3-3"
// label would assert tactical precision this data can't actually support. Ranking by real
// startProbability within each of FPL's own four categories is the honest ceiling for v1.
const MAX_CANDIDATES_PER_POSITION = 5;

export type LineupCandidate = Readonly<{
  player: FplPlayer;
  startProbability: number;
  expectedMinutes: number;
  penaltyRole: boolean;
  setPieceRole: boolean;
  // Signed: positive for the club's top-ranked option at this position (their lead over the next-
  // best real teammate); negative for every other candidate (their deficit versus the top option).
  // null competitor / zero gap only when no other real teammate occupies this position at this club.
  competitionGap: number;
  closestCompetitorName: string | null;
}>;

export type ClubLineupCandidates = Readonly<Record<LineupPosition, readonly LineupCandidate[]>>;

/**
 * Ranks a single real club's own squad by real, already-computed startProbability within each of
 * FPL's own position categories, capped at the top MAX_CANDIDATES_PER_POSITION per category (a
 * display cap, not a significance threshold -- mirrors liveScoringMovers' top-3 cap in fpl.ts).
 * Competition is always measured against the position's real top-ranked option, not the nearest
 * ranked neighbour, so "how much am I trailing the club's first choice" stays the one comparison
 * this reports -- no invented "high/medium/low competition" classification is applied to it.
 */
export function clubLineupCandidates(
  players: readonly FplPlayer[],
  teamId: number,
  eventId: number,
  fixtures: FplFixture[],
  firstEvent: number,
): ClubLineupCandidates {
  const clubPlayers = players.filter(p => p.teamId === teamId);
  const result = {} as Record<LineupPosition, readonly LineupCandidate[]>;
  for (const position of LINEUP_POSITIONS) {
    const ranked = clubPlayers
      .filter(p => p.positionShort === position)
      .map(player => {
        const metrics = projectionMetrics(player, eventId, fixtures, firstEvent);
        return {
          player,
          startProbability: metrics.startProbability,
          expectedMinutes: metrics.expectedMinutes,
          penaltyRole: metrics.penaltyRole,
          setPieceRole: metrics.setPieceRole,
        };
      })
      .sort((a, b) => b.startProbability - a.startProbability);
    const top = ranked[0] ?? null;
    result[position] = ranked.slice(0, MAX_CANDIDATES_PER_POSITION).map((entry, index) => {
      const isTop = index === 0;
      const competitor = isTop ? ranked[1] ?? null : top;
      return {
        player: entry.player,
        startProbability: entry.startProbability,
        expectedMinutes: entry.expectedMinutes,
        penaltyRole: entry.penaltyRole,
        setPieceRole: entry.setPieceRole,
        competitionGap: competitor ? entry.startProbability - competitor.startProbability : 0,
        closestCompetitorName: competitor?.player.name ?? null,
      };
    });
  }
  return result;
}
