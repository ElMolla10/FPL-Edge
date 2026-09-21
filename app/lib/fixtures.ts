/**
 * Authoritative fixture helpers — official FPL /api/fixtures/ mapped once in
 * app/api/fpl/route.ts is the single source of truth. All projection / DGW /
 * blank detection should filter through these helpers rather than ad-hoc loops.
 */
import type { FplFixture, FplPlayer } from "./fpl";

/** Fixtures for a team in a specific event (null event = pending / unassigned). */
export function fixturesForTeamEvent(
  fixtures: readonly FplFixture[],
  teamId: number,
  eventId: number,
): FplFixture[] {
  return fixtures.filter(
    (f) => f.event === eventId && (f.teamH === teamId || f.teamA === teamId),
  );
}

export function fixturesForPlayerEvent(
  fixtures: readonly FplFixture[],
  player: Pick<FplPlayer, "teamId">,
  eventId: number,
): FplFixture[] {
  return fixturesForTeamEvent(fixtures, player.teamId, eventId);
}

export function pendingFixtures(fixtures: readonly FplFixture[]): FplFixture[] {
  return fixtures.filter((f) => f.event === null);
}

export function isBlankGameweek(
  fixtures: readonly FplFixture[],
  teamId: number,
  eventId: number,
): boolean {
  return fixturesForTeamEvent(fixtures, teamId, eventId).length === 0;
}

export function isDoubleGameweek(
  fixtures: readonly FplFixture[],
  teamId: number,
  eventId: number,
): boolean {
  return fixturesForTeamEvent(fixtures, teamId, eventId).length >= 2;
}

/** Validate player club identity against fixture participation (integrity aid). */
export function fixtureTeamIdsForEvent(
  fixtures: readonly FplFixture[],
  eventId: number,
): Set<number> {
  const ids = new Set<number>();
  for (const f of fixtures) {
    if (f.event !== eventId) continue;
    ids.add(f.teamH);
    ids.add(f.teamA);
  }
  return ids;
}
