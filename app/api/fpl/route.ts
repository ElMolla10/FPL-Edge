import { attachIntegrityWarnings } from "../../lib/fpl";

const BOOTSTRAP_URL = "https://fantasy.premierleague.com/api/bootstrap-static/";
const FIXTURES_URL = "https://fantasy.premierleague.com/api/fixtures/";

const number = (value: unknown) => Number(value) || 0;

export async function GET() {
  try {
    const request = {
      headers: { Accept: "application/json", "User-Agent": "FPL-Edge/1.0" },
      next: { revalidate: 300 },
    };
    const [bootstrapResponse, fixturesResponse] = await Promise.all([
      fetch(BOOTSTRAP_URL, request),
      fetch(FIXTURES_URL, request),
    ]);

    if (!bootstrapResponse.ok || !fixturesResponse.ok) {
      throw new Error(`Official FPL feed returned ${bootstrapResponse.status}/${fixturesResponse.status}`);
    }

    const bootstrap = await bootstrapResponse.json();
    const fixtures = await fixturesResponse.json();
    const activeSeasonEvents = bootstrap.events.filter((event: any) => event.is_current || event.started || event.finished);
    const liveEventPayloads = await Promise.all(activeSeasonEvents.map(async (event: any) => {
      const response = await fetch(`https://fantasy.premierleague.com/api/event/${event.id}/live/`, request);
      if (!response.ok) throw new Error(`Official FPL live stats for GW${event.id} returned ${response.status}`);
      return { eventId: event.id, payload: await response.json() };
    }));
    const aggregateFields = ["total_points","goals_scored","assists","expected_goals","expected_assists","expected_goal_involvements","expected_goals_conceded","clean_sheets","goals_conceded","minutes","starts","bonus","bps","ict_index","influence","creativity","threat","saves","penalties_saved","defensive_contribution","clearances_blocks_interceptions","recoveries","tackles"];
    const seasonStats = new Map<number, any>();
    for (const { eventId, payload } of liveEventPayloads) for (const element of payload.elements) {
      const aggregate = seasonStats.get(element.id) ?? { appearances: 0, eventPoints: 0, eventMinutes: 0 };
      for (const field of aggregateFields) aggregate[field] = number(aggregate[field]) + number(element.stats?.[field]);
      if (number(element.stats?.minutes) > 0) aggregate.appearances += 1;
      aggregate.eventPoints = number(element.stats?.total_points);
      // Same overwrite-not-sum pattern as eventPoints: minutes in the LATEST active event only, not
      // a season total (that's the existing `minutes` field below). Needed to detect a 0-minute
      // starter for autosub simulation -- season-cumulative minutes can't tell you if a player who
      // started earlier gameweeks specifically played 0 minutes in *this* one.
      aggregate.eventMinutes = number(element.stats?.minutes);
      aggregate.latestEvent = eventId;
      seasonStats.set(element.id, aggregate);
    }
    const teams = new Map(bootstrap.teams.map((team: any) => [team.id, team]));
    const positions = new Map(bootstrap.element_types.map((position: any) => [position.id, position]));

    const payload = {
      updatedAt: new Date().toISOString(),
      source: BOOTSTRAP_URL,
      seasonStatsThrough: activeSeasonEvents.length ? Math.max(...activeSeasonEvents.map((event: any) => event.id)) : 0,
      rules: {
        budget: number(bootstrap.game_settings?.squad_total_spend) / 10,
        // squad_squadplay is the XI size (11); the draft size is the sum of the
        // official positional quotas: 2 GKP + 5 DEF + 5 MID + 3 FWD = 15.
        squadSize: bootstrap.element_types.reduce((sum: number, position: any) => sum + number(position.squad_select), 0),
        teamLimit: number(bootstrap.game_settings?.squad_team_limit),
        positions: bootstrap.element_types.map((position: any) => ({
          id: position.id,
          name: position.singular_name,
          short: position.plural_name_short,
          squad: position.squad_select,
          minPlay: position.squad_min_play,
          maxPlay: position.squad_max_play,
        })),
      },
      events: bootstrap.events.map((event: any) => ({
        id: event.id,
        name: event.name,
        deadline: event.deadline_time,
        current: event.is_current,
        next: event.is_next,
        finished: event.finished,
      })),
      teams: bootstrap.teams.map((team: any) => ({
        id: team.id,
        name: team.name,
        short: team.short_name,
      })),
      players: bootstrap.elements.map((player: any) => {
        const team: any = teams.get(player.team);
        const position: any = positions.get(player.element_type);
        const season = seasonStats.get(player.id) ?? {};
        const appearances = number(season.appearances);
        return {
          id: player.id,
          name: player.web_name,
          firstName: player.first_name,
          secondName: player.second_name,
          teamId: player.team,
          teamName: team?.name ?? "Unknown",
          teamShort: team?.short_name ?? "—",
          positionId: player.element_type,
          position: position?.singular_name ?? "Unknown",
          positionShort: position?.plural_name_short ?? "—",
          price: number(player.now_cost) / 10,
          status: player.status,
          chance: player.chance_of_playing_next_round,
          epNext: number(player.ep_next),
          form: number(player.form),
          pointsPerGame: appearances ? number(season.total_points) / appearances : number(player.points_per_game),
          priorPointsPerGame: number(player.points_per_game),
          priorMinutes: number(player.minutes),
          priorStarts: number(player.starts),
          priorExpectedGoals: number(player.expected_goals),
          priorExpectedAssists: number(player.expected_assists),
          priorBonus: number(player.bonus),
          priorSaves: number(player.saves),
          priorPenaltiesSaved: number(player.penalties_saved),
          priorDefensiveContribution: number(player.defensive_contribution),
          totalPoints: number(season.total_points),
          eventPoints: number(season.eventPoints),
          eventMinutes: number(season.eventMinutes),
          goals: number(season.goals_scored),
          assists: number(season.assists),
          expectedGoals: number(season.expected_goals),
          expectedAssists: number(season.expected_assists),
          expectedGoalInvolvements: number(season.expected_goal_involvements),
          expectedGoalsConceded: number(season.expected_goals_conceded),
          cleanSheets: number(season.clean_sheets),
          goalsConceded: number(season.goals_conceded),
          minutes: number(season.minutes),
          starts: number(season.starts),
          bonus: number(season.bonus),
          bps: number(season.bps),
          ictIndex: number(season.ict_index),
          influence: number(season.influence),
          creativity: number(season.creativity),
          threat: number(season.threat),
          saves: number(season.saves),
          penaltiesSaved: number(season.penalties_saved),
          defensiveContribution: number(season.defensive_contribution),
          clearancesBlocksInterceptions: number(season.clearances_blocks_interceptions),
          recoveries: number(season.recoveries),
          tackles: number(season.tackles),
          penaltiesOrder: player.penalties_order,
          directFreekicksOrder: player.direct_freekicks_order,
          cornersOrder: player.corners_and_indirect_freekicks_order,
          scoutRisks: player.scout_risks || [],
          news: player.news || "",
          newsAdded: player.news_added,
          selectedBy: number(player.selected_by_percent),
          transfersIn: number(player.transfers_in_event),
          transfersOut: number(player.transfers_out_event),
          priceChange: number(player.cost_change_event) / 10,
          // FPL's own first-party, end-of-day price-change forecast (price_change_projections[0]
          // is today's offset) -- not a heuristic estimated from raw transfer counts. Positive =
          // rise pressure, negative = fall pressure, roughly in percent-toward-whatever-threshold
          // FPL's undisclosed algorithm uses. Signed string in the raw feed; coerced to a number.
          priceProjectionToday: number(player.price_change_projections?.[0]?.projected_percent),
        };
      }),
      fixtures: fixtures.map((fixture: any) => ({
        id: fixture.id,
        event: fixture.event,
        teamH: fixture.team_h,
        teamA: fixture.team_a,
        teamHDifficulty: fixture.team_h_difficulty,
        teamADifficulty: fixture.team_a_difficulty,
        finished: fixture.finished,
        kickoff: fixture.kickoff_time,
        started: fixture.started,
        teamHScore: fixture.team_h_score,
        teamAScore: fixture.team_a_score,
      })),
    };

    return Response.json(attachIntegrityWarnings(payload), {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
    });
  } catch (error) {
    return Response.json(
      { error: "Official FPL data is temporarily unavailable. No substitute or demo roster has been shown.", detail: error instanceof Error ? error.message : "Unknown error" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
