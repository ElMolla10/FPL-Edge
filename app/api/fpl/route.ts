import { attachIntegrityWarnings, isLowPlContinuity, plRosterContinuity, playerCalibrationProfile } from "../../lib/fpl";
import { buildTeamQualityProfiles } from "../../lib/team-quality";
import priorSeasonSnapshot from "../../data/prior-season-2025-26.json";

const BOOTSTRAP_URL = "https://fantasy.premierleague.com/api/bootstrap-static/";
const FIXTURES_URL = "https://fantasy.premierleague.com/api/fixtures/";

const number = (value: unknown) => Number(value) || 0;
type PriorSeasonRecord = (typeof priorSeasonSnapshot.players)[number];
const priorByPlayerId = new Map<number, PriorSeasonRecord>(priorSeasonSnapshot.players.map((player) => [player.id, player]));

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
    const statsEvents = bootstrap.events.filter((event: any) => event.is_current || event.started || event.finished);
    const completedEventIds = new Set<number>(bootstrap.events.filter((event: any) => event.finished && event.data_checked).map((event: any) => event.id));
    const liveEventPayloads = await Promise.all(statsEvents.map(async (event: any) => {
      const response = await fetch(`https://fantasy.premierleague.com/api/event/${event.id}/live/`, request);
      if (!response.ok) throw new Error(`Official FPL live stats for GW${event.id} returned ${response.status}`);
      return { eventId: event.id, payload: await response.json() };
    }));
    const aggregateFields = ["total_points","goals_scored","assists","expected_goals","expected_assists","expected_goal_involvements","expected_goals_conceded","clean_sheets","goals_conceded","minutes","starts","bonus","bps","ict_index","influence","creativity","threat","saves","penalties_saved","defensive_contribution","clearances_blocks_interceptions","recoveries","tackles"];
    const seasonStats = new Map<number, any>();
    const latestEventStats = new Map<number, any>();
    for (const { eventId, payload } of liveEventPayloads) for (const element of payload.elements) {
      const latest = latestEventStats.get(element.id);
      if (!latest || eventId >= latest.eventId) latestEventStats.set(element.id, { eventId, ...element.stats });
      // Future projections must never learn from a match while it is still being played. Current
      // event points remain available through latestEventStats for the live-scoring view, while
      // season aggregates advance only after FPL marks the whole event finished and data-checked.
      if (completedEventIds.has(eventId)) {
        const aggregate = seasonStats.get(element.id) ?? { appearances: 0 };
        for (const field of aggregateFields) aggregate[field] = number(aggregate[field]) + number(element.stats?.[field]);
        if (number(element.stats?.minutes) > 0) aggregate.appearances += 1;
        seasonStats.set(element.id, aggregate);
      }
    }
    const teams = new Map(bootstrap.teams.map((team: any) => [team.id, team]));
    const positions = new Map(bootstrap.element_types.map((position: any) => [position.id, position]));
    const matchedPriorByPlayerId = new Map<number, PriorSeasonRecord>();
    const priorMinutesByTeam = new Map<number, number[]>();
    for (const player of bootstrap.elements) {
      const candidate = priorByPlayerId.get(player.id);
      const prior = candidate?.code === player.code ? candidate : undefined;
      if (prior) matchedPriorByPlayerId.set(player.id, prior);
      priorMinutesByTeam.set(player.team, [...(priorMinutesByTeam.get(player.team) ?? []), prior?.minutes ?? 0]);
    }
    const teamPriorProfiles = new Map<number, { coverage: number; low: boolean }>();
    for (const [teamId, minutes] of priorMinutesByTeam) {
      const coverage = plRosterContinuity(minutes);
      teamPriorProfiles.set(teamId, { coverage, low: isLowPlContinuity(coverage) });
    }
    const completedFixtures=fixtures.filter((fixture:any)=>completedEventIds.has(fixture.event)&&fixture.finished);
    const teamQualityInputs=bootstrap.teams.map((team:any)=>{
      const home=completedFixtures.filter((fixture:any)=>fixture.team_h===team.id),away=completedFixtures.filter((fixture:any)=>fixture.team_a===team.id);
      const expectedGoalsFor=bootstrap.elements.filter((player:any)=>player.team===team.id).reduce((sum:number,player:any)=>sum+number(seasonStats.get(player.id)?.expected_goals),0);
      const profile=teamPriorProfiles.get(team.id)??{coverage:0,low:true};
      return{id:team.id,name:team.name,short:team.short_name,officialAttackHome:number(team.strength_attack_home),officialAttackAway:number(team.strength_attack_away),officialDefenceHome:number(team.strength_defence_home),officialDefenceAway:number(team.strength_defence_away),plPriorCoverage:profile.coverage,lowPlContinuity:profile.low,matches:home.length+away.length,homeMatches:home.length,awayMatches:away.length,goalsForHome:home.reduce((sum:number,fixture:any)=>sum+number(fixture.team_h_score),0),goalsForAway:away.reduce((sum:number,fixture:any)=>sum+number(fixture.team_a_score),0),goalsAgainstHome:home.reduce((sum:number,fixture:any)=>sum+number(fixture.team_a_score),0),goalsAgainstAway:away.reduce((sum:number,fixture:any)=>sum+number(fixture.team_h_score),0),expectedGoalsFor};
    });
    const teamQualityProfiles=new Map(buildTeamQualityProfiles(teamQualityInputs).map(profile=>[profile.id,profile]));

    const payload = {
      updatedAt: new Date().toISOString(),
      source: BOOTSTRAP_URL,
      seasonStatsThrough: completedEventIds.size ? Math.max(...completedEventIds) : 0,
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
        dataChecked: event.data_checked,
      })),
      teams: bootstrap.teams.map((team: any) => ({
        id: team.id,
        name: team.name,
        short: team.short_name,
        strengthHome: number(team.strength_overall_home) || 3,
        strengthAway: number(team.strength_overall_away) || 3,
        attackHome: number(team.strength_attack_home) || null,
        attackAway: number(team.strength_attack_away) || null,
        defenceHome: number(team.strength_defence_home) || null,
        defenceAway: number(team.strength_defence_away) || null,
        plPriorCoverage: teamPriorProfiles.get(team.id)?.coverage ?? 0,
        lowPlContinuity: teamPriorProfiles.get(team.id)?.low ?? true,
        quality: teamQualityProfiles.get(team.id),
      })),
      players: bootstrap.elements.map((player: any) => {
        const team: any = teams.get(player.team);
        const position: any = positions.get(player.element_type);
        const season = seasonStats.get(player.id) ?? {};
        const latest = latestEventStats.get(player.id) ?? {};
        // Element ids are stable within an FPL season, while the immutable player code is the
        // stronger identity key. Refuse a stale snapshot row if the two ever stop agreeing.
        const prior = matchedPriorByPlayerId.get(player.id);
        const appearances = number(season.appearances);
        const priorEquivalentMatches = prior?.minutes ? prior.minutes / 90 : 0;
        const teamMatchesPlayed = fixtures.filter((fixture: any) => completedEventIds.has(fixture.event) && (fixture.team_h === player.team || fixture.team_a === player.team)).length;
        const priorProfile = teamPriorProfiles.get(player.team) ?? { coverage: 0, low: true };
        const teamQuality=teamQualityProfiles.get(player.team);
        const record = {
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
          pointsPerGame: appearances ? number(season.total_points) / appearances : 0,
          priorPointsPerGame: priorEquivalentMatches ? prior!.totalPoints / priorEquivalentMatches : 0,
          priorMinutes: prior?.minutes ?? 0,
          priorStarts: prior?.starts ?? 0,
          priorExpectedGoals: prior?.expectedGoals ?? 0,
          priorExpectedAssists: prior?.expectedAssists ?? 0,
          priorBonus: prior?.bonus ?? 0,
          priorSaves: prior?.saves ?? 0,
          priorPenaltiesSaved: prior?.penaltiesSaved ?? 0,
          priorDefensiveContribution: prior?.defensiveContribution ?? 0,
          priorSource: prior ? "official-pl-history" as const : "position-baseline" as const,
          priorSeason: prior?.season ?? null,
          priorCompetition: prior ? priorSeasonSnapshot.competition : null,
          teamPlPriorCoverage: priorProfile.coverage,
          lowPlContinuityClub: priorProfile.low,
          teamMatchesPlayed,
          teamStrengthHome: number(team?.strength_overall_home) || 3,
          teamStrengthAway: number(team?.strength_overall_away) || 3,
          teamAttackHome: number(team?.strength_attack_home) || null,
          teamAttackAway: number(team?.strength_attack_away) || null,
          teamDefenceHome: number(team?.strength_defence_home) || null,
          teamDefenceAway: number(team?.strength_defence_away) || null,
          teamQualityAttackHome: teamQuality?.effectiveAttackHome ?? 1,
          teamQualityAttackAway: teamQuality?.effectiveAttackAway ?? 1,
          teamQualityDefenceHome: teamQuality?.effectiveDefenceHome ?? 1,
          teamQualityDefenceAway: teamQuality?.effectiveDefenceAway ?? 1,
          teamQualityConfidence: teamQuality?.confidence ?? .25,
          totalPoints: number(season.total_points),
          eventPoints: number(latest.total_points),
          eventMinutes: number(latest.minutes),
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
        return { ...record, calibrationGroup: playerCalibrationProfile(record).group };
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
        teamHAttackQuality: teamQualityProfiles.get(fixture.team_h)?.effectiveAttackHome ?? 1,
        teamHDefenceQuality: teamQualityProfiles.get(fixture.team_h)?.effectiveDefenceHome ?? 1,
        teamAAttackQuality: teamQualityProfiles.get(fixture.team_a)?.effectiveAttackAway ?? 1,
        teamADefenceQuality: teamQualityProfiles.get(fixture.team_a)?.effectiveDefenceAway ?? 1,
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
