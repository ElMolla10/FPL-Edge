export const FULL_LEAGUE_ANALYSIS_CAP = 20;
export const MINI_LEAGUE_MAX_SELECTED_RIVALS = 8;

export type MiniLeagueStandingRow = {
  entryId: number;
  managerName: string;
  teamName: string;
  rank: number;
  lastRank: number | null;
  rankChange: number | null;
  gameweekPoints: number;
  totalPoints: number;
  pointsGap: number;
  isConnected: boolean;
};

export type MiniLeagueStandingsResult = {
  source: "official-fpl";
  seasonOver: boolean;
  partial: boolean;
  league: {
    id: number;
    name: string;
    scoring: "c";
    closed: boolean;
    startEvent: number;
  };
  connectedManager: {
    entryId: number;
    rank: number;
    lastRank: number | null;
    rankChange: number | null;
    gameweekPoints: number;
    totalPoints: number;
    page: number;
    leagueSize: number;
  };
  standings: {
    page: number;
    hasNext: boolean;
    rows: MiniLeagueStandingRow[];
  };
  freshness: {
    officialUpdatedAt: string | null;
    fetchedAt: string;
    stale: boolean;
    warnings: string[];
  };
};

export type MiniLeagueUiState =
  | { status: "idle" }
  | { status: "loading"; leagueId: number; page?: number }
  | { status: "available"; result: MiniLeagueStandingsResult }
  | { status: "error"; reason: string; kind: "invalid" | "membership" | "unsupported" | "inaccessible" | "timeout" | "upstream" | "unexpected" };

export type MiniLeagueClientResponse = MiniLeagueStandingsResult | { error: string; code?: string };
