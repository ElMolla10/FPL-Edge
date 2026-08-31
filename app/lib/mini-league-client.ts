import type {
  MiniLeagueClientResponse,
  MiniLeagueStandingsResult,
  MiniLeagueUiState,
} from "./mini-league";

type MiniLeagueRequest = {
  leagueId: number;
  entryId: number;
  page?: number;
};

type MiniLeagueStatePublisher = (state: MiniLeagueUiState) => void;

const errorKind = (
  status: number,
  code: string | undefined,
): Extract<MiniLeagueUiState, { status: "error" }>['kind'] => {
  if (status === 400 || code === "invalid-league" || code === "invalid-entry" || code === "invalid-page") return "invalid";
  if (status === 409 || code === "not-a-member") return "membership";
  if (status === 422 || code === "unsupported-scoring") return "unsupported";
  if (status === 404 || code === "league-inaccessible") return "inaccessible";
  if (status === 504 || code === "fpl-timeout") return "timeout";
  if (status === 502 || status === 503 || code === "fpl-upstream") return "upstream";
  return "unexpected";
};

export function parseLeagueIdInput(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isStandingsResult(value: MiniLeagueClientResponse): value is MiniLeagueStandingsResult {
  if (!value || typeof value !== "object" || "error" in value) return false;
  return value.source === "official-fpl"
    && Number.isSafeInteger(value.league?.id)
    && Array.isArray(value.standings?.rows)
    && Number.isSafeInteger(value.connectedManager?.entryId)
    && typeof value.freshness?.fetchedAt === "string";
}

export function createMiniLeagueRequestManager(
  fetcher: typeof fetch = fetch,
) {
  let generation = 0;
  let activeController: AbortController | null = null;

  const cancel = () => {
    generation += 1;
    activeController?.abort();
    activeController = null;
  };

  const load = async (request: MiniLeagueRequest, publish: MiniLeagueStatePublisher) => {
    activeController?.abort();
    const requestGeneration = ++generation;
    const controller = new AbortController();
    activeController = controller;
    publish({ status: "loading", leagueId: request.leagueId, ...(request.page ? { page: request.page } : {}) });

    const params = new URLSearchParams({
      league: String(request.leagueId),
      entry: String(request.entryId),
    });
    if (request.page) params.set("page", String(request.page));

    try {
      const response = await fetcher(`/api/fpl/league?${params}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json() as MiniLeagueClientResponse;
      if (requestGeneration !== generation) return;
      if (!response.ok) {
        const failure = body as { error?: unknown; code?: unknown };
        publish({
          status: "error",
          kind: errorKind(response.status, typeof failure.code === "string" ? failure.code : undefined),
          reason: typeof failure.error === "string" && failure.error.trim()
            ? failure.error
            : "Official FPL could not provide these league standings.",
        });
        return;
      }
      if (!isStandingsResult(body)) {
        publish({ status: "error", kind: "unexpected", reason: "Official FPL returned an invalid Mini-League response." });
        return;
      }
      publish({ status: "available", result: body });
    } catch (error) {
      if (requestGeneration !== generation || controller.signal.aborted) return;
      publish({
        status: "error",
        kind: "unexpected",
        reason: error instanceof Error && error.message ? error.message : "The Mini-League request failed unexpectedly.",
      });
    } finally {
      if (requestGeneration === generation) activeController = null;
    }
  };

  return { load, cancel };
}
