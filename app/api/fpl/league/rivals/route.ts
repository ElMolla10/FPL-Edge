import { createMiniLeagueGateway, MiniLeagueGatewayError, parsePositiveInteger, type RivalPicksResult } from "../../../../lib/mini-league-server";

type RivalGateway = { loadRivalPicks(input: { leagueId: number; entryId: number }): Promise<RivalPicksResult> };
const gateway = createMiniLeagueGateway();

export function createRivalPicksRoute(service: RivalGateway) {
  return async function GET(request: Request): Promise<Response> {
    try {
      const search = new URL(request.url).searchParams;
      const leagueId = parsePositiveInteger(search.get("league"), "league");
      const entryId = parsePositiveInteger(search.get("entry"), "entry");
      const result = await service.loadRivalPicks({ leagueId, entryId });
      return Response.json(result, { headers: { "Cache-Control": "private, max-age=300" } });
    } catch (error) {
      if (error instanceof MiniLeagueGatewayError) {
        return Response.json({ error: error.message, code: error.code, retryable: error.retryable }, { status: error.status, headers: { "Cache-Control": "no-store" } });
      }
      return Response.json({ error: "The rival picks request failed unexpectedly.", code: "unexpected" }, { status: 500, headers: { "Cache-Control": "no-store" } });
    }
  };
}

export const GET = createRivalPicksRoute(gateway);
