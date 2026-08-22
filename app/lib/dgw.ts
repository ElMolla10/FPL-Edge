import { FplData } from "./fpl";

export type DoubleGameweek = { eventId: number; teamId: number; fixtureIds: number[] };
export type BlankGameweek = { eventId: number; teamId: number };
export type PendingFixture = { fixtureId: number; teamH: number; teamA: number };

export type FixtureAnomalies = {
  doubles: DoubleGameweek[];
  blanks: BlankGameweek[];
  pending: PendingFixture[];
};

// Doubles, blanks and pending (event: null, rearranged but not yet re-scheduled) fixtures are all
// derivable from data the app already fetches every refresh -- no additional API call needed.
// Only unfinished events are considered for blanks/doubles: a gameweek that has already been
// played isn't something to plan around, and reporting it would just be noise.
export function detectFixtureAnomalies(data: FplData): FixtureAnomalies {
  const scheduled = data.fixtures.filter((f) => f.event !== null);
  const pending: PendingFixture[] = data.fixtures
    .filter((f) => f.event === null)
    .map((f) => ({ fixtureId: f.id, teamH: f.teamH, teamA: f.teamA }));

  const fixturesByTeamEvent = new Map<string, number[]>();
  for (const fixture of scheduled) {
    for (const teamId of [fixture.teamH, fixture.teamA]) {
      const key = `${teamId}:${fixture.event}`;
      const existing = fixturesByTeamEvent.get(key);
      if (existing) existing.push(fixture.id);
      else fixturesByTeamEvent.set(key, [fixture.id]);
    }
  }

  const doubles: DoubleGameweek[] = [];
  for (const [key, fixtureIds] of fixturesByTeamEvent) {
    if (fixtureIds.length < 2) continue;
    const [teamId, eventId] = key.split(":").map(Number);
    doubles.push({ eventId, teamId, fixtureIds });
  }

  const unfinishedEvents = data.events.filter((e) => !e.finished);
  const blanks: BlankGameweek[] = [];
  for (const event of unfinishedEvents) {
    for (const team of data.teams) {
      if (!fixturesByTeamEvent.has(`${team.id}:${event.id}`)) {
        blanks.push({ eventId: event.id, teamId: team.id });
      }
    }
  }

  return { doubles, blanks, pending };
}
