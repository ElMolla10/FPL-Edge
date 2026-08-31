import { createMiniLeagueGateway, MiniLeagueGatewayError, MINI_LEAGUE_MAX_STANDINGS_PAGE, parsePositiveInteger } from "../../../lib/mini-league-server";
import type { MiniLeagueStandingsResult } from "../../../lib/mini-league";

type LeagueGateway = {
  loadStandings(input: { leagueId: number; entryId: number; page?: number }): Promise<MiniLeagueStandingsResult>;
};

const gateway = createMiniLeagueGateway();

export function createMiniLeagueRoute(service: LeagueGateway) {
  return async function GET(request: Request): Promise<Response> {
    try {
      const search = new URL(request.url).searchParams;
      const leagueId = parsePositiveInteger(search.get("league"), "league");
      const entryId = parsePositiveInteger(search.get("entry"), "entry");
      const rawPage = search.get("page");
      const page = rawPage === null ? undefined : parsePositiveInteger(rawPage, "page", MINI_LEAGUE_MAX_STANDINGS_PAGE);
      const result = await service.loadStandings({ leagueId, entryId, page });
      return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      if (error instanceof MiniLeagueGatewayError) {
        return Response.json(
          { error: error.message, code: error.code, retryable: error.retryable },
          { status: error.status, headers: { "Cache-Control": "no-store" } },
        );
      }
      return Response.json(
        { error: "The Mini-League request failed unexpectedly.", code: "unexpected" },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }
  };
}

export const GET = createMiniLeagueRoute(gateway);

