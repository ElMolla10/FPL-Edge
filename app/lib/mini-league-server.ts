import type { MiniLeagueStandingRow, MiniLeagueStandingsResult } from "./mini-league";

const FPL = "https://fantasy.premierleague.com/api";
export const MINI_LEAGUE_MAX_CONCURRENCY = 3;
export const MINI_LEAGUE_TIMEOUT_MS = 8_000;
export const MINI_LEAGUE_CACHE_MAX_ENTRIES = 128;
export const MINI_LEAGUE_STANDINGS_TTL_MS = 60_000;
export const MINI_LEAGUE_METADATA_TTL_MS = 300_000;
export const MINI_LEAGUE_STALE_IF_ERROR_MS = 15 * 60_000;
export const MINI_LEAGUE_MAX_STANDINGS_PAGE = 200;
const STANDINGS_PAGE_SIZE = 50;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;

export class MiniLeagueGatewayError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "MiniLeagueGatewayError";
  }
}

export function parsePositiveInteger(value: string | null | undefined, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const normalized = value?.trim() ?? "";
  if (!/^\d+$/.test(normalized)) throw new MiniLeagueGatewayError(400, `${label} must be a positive integer.`, `invalid-${label}`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new MiniLeagueGatewayError(400, `${label} must be between 1 and ${maximum}.`, `invalid-${label}`);
  }
  return parsed;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

type CacheEntry<T> = { value: T; fetchedAt: number };
export type CacheRead<T> = { value: T; state: "fresh" | "stale" };

export class BoundedTtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  constructor(private readonly maximumEntries: number) {
    if (!Number.isInteger(maximumEntries) || maximumEntries < 1) throw new Error("Cache size must be a positive integer.");
  }
  get size() { return this.entries.size; }
  get(key: string, now: number, ttlMs: number, staleIfErrorMs: number): CacheRead<T> | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const age = Math.max(0, now - entry.fetchedAt);
    if (age > staleIfErrorMs) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { value: deepFreeze(structuredClone(entry.value)), state: age < ttlMs ? "fresh" : "stale" };
  }
  set(key: string, value: T, fetchedAt: number): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value: deepFreeze(structuredClone(value)), fetchedAt });
    while (this.entries.size > this.maximumEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export type ConcurrencyLimiter = { run<T>(operation: () => Promise<T>): Promise<T> };
export function createConcurrencyLimiter(maximum: number): ConcurrencyLimiter {
  if (!Number.isInteger(maximum) || maximum < 1) throw new Error("Concurrency must be a positive integer.");
  let active = 0;
  const queue: (() => void)[] = [];
  const release = () => {
    active--;
    queue.shift()?.();
  };
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const start = () => {
          active++;
          operation().then(resolve, reject).finally(release);
        };
        if (active < maximum) start();
        else queue.push(start);
      });
    },
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function positiveInteger(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && Number.isSafeInteger(number) && number >= 1 ? number : null;
}
function nonNegativeNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}
function rankChange(rank: number, lastRank: number | null): number | null {
  return lastRank === null ? null : lastRank - rank;
}

type OfficialRead = { data: unknown; stale: boolean };
type PageRead = {
  league: MiniLeagueStandingsResult["league"];
  page: number;
  hasNext: boolean;
  rows: Omit<MiniLeagueStandingRow, "pointsGap" | "isConnected">[];
  malformedRows: number;
  officialUpdatedAt: string | null;
  stale: boolean;
};

type GatewayOptions = {
  fetcher?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  cacheMaxEntries?: number;
  standingsTtlMs?: number;
  metadataTtlMs?: number;
  staleIfErrorMs?: number;
  limiter?: ConcurrencyLimiter;
};

function upstreamError(kind: "entry" | "bootstrap" | "standings", status: number): MiniLeagueGatewayError {
  if (status === 404 || status === 403) {
    return kind === "standings"
      ? new MiniLeagueGatewayError(404, "That league was not found or is not publicly accessible.", "league-inaccessible")
      : new MiniLeagueGatewayError(404, "The connected FPL Team ID was not found.", "entry-not-found");
  }
  if (status === 429) return new MiniLeagueGatewayError(503, "Official FPL temporarily rate-limited the Mini-League request.", "fpl-rate-limited", true);
  return new MiniLeagueGatewayError(502, "Official FPL could not provide the Mini-League data.", "fpl-upstream", true);
}

export function createMiniLeagueGateway(options: GatewayOptions = {}) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? MINI_LEAGUE_TIMEOUT_MS;
  const standingsTtlMs = options.standingsTtlMs ?? MINI_LEAGUE_STANDINGS_TTL_MS;
  const metadataTtlMs = options.metadataTtlMs ?? MINI_LEAGUE_METADATA_TTL_MS;
  const staleIfErrorMs = options.staleIfErrorMs ?? MINI_LEAGUE_STALE_IF_ERROR_MS;
  const cache = new BoundedTtlCache<unknown>(options.cacheMaxEntries ?? MINI_LEAGUE_CACHE_MAX_ENTRIES);
  const limiter = options.limiter ?? createConcurrencyLimiter(MINI_LEAGUE_MAX_CONCURRENCY);

  async function fetchWithTimeout(url: string): Promise<Response> {
    return limiter.run(async () => {
      const controller = new AbortController();
      let timedOut = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort(new Error("Official FPL request timed out."));
          reject(new MiniLeagueGatewayError(504, "The Official FPL Mini-League request timed out after eight seconds.", "fpl-timeout", true));
        }, timeoutMs);
      });
      try {
        return await Promise.race([
          fetcher(url, { headers: { Accept: "application/json", "User-Agent": "FPL-Edge/1.0" }, signal: controller.signal }),
          timeoutPromise,
        ]);
      } catch (error) {
        if (timedOut) throw new MiniLeagueGatewayError(504, "The Official FPL Mini-League request timed out after eight seconds.", "fpl-timeout", true);
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    });
  }

  async function officialJson(url: string, kind: "entry" | "bootstrap" | "standings", ttlMs: number): Promise<OfficialRead> {
    const cached = cache.get(url, now(), ttlMs, staleIfErrorMs);
    if (cached?.state === "fresh") return { data: cached.value, stale: false };
    try {
      const response = await fetchWithTimeout(url);
      if (!response.ok) throw upstreamError(kind, response.status);
      let data: unknown;
      try { data = await response.json(); }
      catch { throw new MiniLeagueGatewayError(502, "Official FPL returned malformed JSON.", "fpl-malformed", true); }
      cache.set(url, data, now());
      return { data: deepFreeze(structuredClone(data)), stale: false };
    } catch (error) {
      const normalized = error instanceof MiniLeagueGatewayError
        ? error
        : new MiniLeagueGatewayError(502, "Official FPL could not provide the Mini-League data.", "fpl-upstream", true);
      if (cached?.state === "stale" && normalized.retryable) return { data: cached.value, stale: true };
      throw normalized;
    }
  }

  function parseMembership(data: unknown, leagueId: number, entryId: number) {
    if (!isRecord(data) || positiveInteger(data.id) !== entryId || !isRecord(data.leagues) || !Array.isArray(data.leagues.classic)) {
      throw new MiniLeagueGatewayError(502, "Official FPL returned malformed connected-entry data.", "entry-malformed");
    }
    const membership = data.leagues.classic.find(value => isRecord(value) && positiveInteger(value.id) === leagueId);
    if (!isRecord(membership)) throw new MiniLeagueGatewayError(409, "The connected FPL Team ID does not belong to that classic league.", "not-a-member");
    const rank = positiveInteger(membership.entry_rank);
    const leagueSize = positiveInteger(membership.rank_count);
    const rawLastRank = nonNegativeNumber(membership.entry_last_rank);
    if (rank === null || leagueSize === null) throw new MiniLeagueGatewayError(502, "Official FPL returned malformed league membership data.", "membership-malformed");
    return { rank, lastRank: rawLastRank && rawLastRank > 0 ? rawLastRank : null, leagueSize };
  }

  function parseSeasonOver(data: unknown): boolean {
    if (!isRecord(data) || !Array.isArray(data.events) || data.events.length !== 38 || data.events.some(event => !isRecord(event) || typeof event.finished !== "boolean")) {
      throw new MiniLeagueGatewayError(502, "Official FPL returned malformed event data.", "events-malformed");
    }
    return data.events.every(event => (event as JsonRecord).finished === true);
  }

  function parsePage(data: unknown, expectedPage: number, stale: boolean): PageRead {
    if (!isRecord(data) || !isRecord(data.league) || !isRecord(data.standings) || !Array.isArray(data.standings.results)) {
      throw new MiniLeagueGatewayError(502, "Official FPL returned malformed league standings data.", "standings-malformed");
    }
    const leagueId = positiveInteger(data.league.id);
    const leagueName = typeof data.league.name === "string" && data.league.name.trim() ? data.league.name.trim() : null;
    const scoring = data.league.scoring;
    const startEvent = positiveInteger(data.league.start_event);
    if (leagueId === null || !leagueName || startEvent === null || typeof data.league.closed !== "boolean" || typeof scoring !== "string") {
      throw new MiniLeagueGatewayError(502, "Official FPL returned malformed league metadata.", "league-malformed");
    }
    if (scoring !== "c") throw new MiniLeagueGatewayError(422, "This War Room supports classic scoring leagues only.", "unsupported-scoring");
    const page = positiveInteger(data.standings.page);
    if (page !== expectedPage || typeof data.standings.has_next !== "boolean") {
      throw new MiniLeagueGatewayError(502, "Official FPL returned malformed standings pagination.", "pagination-malformed");
    }
    let malformedRows = 0;
    const rows = data.standings.results.flatMap((raw): PageRead["rows"] => {
      if (!isRecord(raw)) { malformedRows++; return []; }
      const entryId = positiveInteger(raw.entry);
      const rank = positiveInteger(raw.rank);
      const eventTotal = nonNegativeNumber(raw.event_total);
      const total = nonNegativeNumber(raw.total);
      const managerName = typeof raw.player_name === "string" && raw.player_name.trim() ? raw.player_name.trim() : null;
      const teamName = typeof raw.entry_name === "string" && raw.entry_name.trim() ? raw.entry_name.trim() : null;
      const rawLastRank = nonNegativeNumber(raw.last_rank);
      if (entryId === null || rank === null || eventTotal === null || total === null || !managerName || !teamName) {
        malformedRows++;
        return [];
      }
      const lastRank = rawLastRank && rawLastRank > 0 ? rawLastRank : null;
      return [{ entryId, managerName, teamName, rank, lastRank, rankChange: rankChange(rank, lastRank), gameweekPoints: eventTotal, totalPoints: total }];
    });
    return {
      league: { id: leagueId, name: leagueName, scoring: "c", closed: data.league.closed, startEvent },
      page,
      hasNext: data.standings.has_next,
      rows,
      malformedRows,
      officialUpdatedAt: typeof data.last_updated_data === "string" ? data.last_updated_data : null,
      stale,
    };
  }

  async function loadPage(leagueId: number, page: number): Promise<PageRead> {
    const read = await officialJson(`${FPL}/leagues-classic/${leagueId}/standings/?page_standings=${page}`, "standings", standingsTtlMs);
    const parsed = parsePage(read.data, page, read.stale);
    if (parsed.league.id !== leagueId) throw new MiniLeagueGatewayError(502, "Official FPL returned a different league than requested.", "league-mismatch");
    return parsed;
  }

  async function loadStandings(input: { leagueId: number; entryId: number; page?: number }): Promise<MiniLeagueStandingsResult> {
    const leagueId = parsePositiveInteger(String(input.leagueId), "league");
    const entryId = parsePositiveInteger(String(input.entryId), "entry");
    const requestedPage = input.page === undefined ? undefined : parsePositiveInteger(String(input.page), "page", MINI_LEAGUE_MAX_STANDINGS_PAGE);
    const [entryRead, bootstrapRead] = await Promise.all([
      officialJson(`${FPL}/entry/${entryId}/`, "entry", metadataTtlMs),
      officialJson(`${FPL}/bootstrap-static/`, "bootstrap", metadataTtlMs),
    ]);
    const membership = parseMembership(entryRead.data, leagueId, entryId);
    const seasonOver = parseSeasonOver(bootstrapRead.data);
    const calculatedPage = Math.min(MINI_LEAGUE_MAX_STANDINGS_PAGE, Math.max(1, Math.ceil(membership.rank / STANDINGS_PAGE_SIZE)));
    const calculated = await loadPage(leagueId, calculatedPage);
    let userPage = calculated;
    let userRow = calculated.rows.find(row => row.entryId === entryId);
    const probedPages: PageRead[] = [calculated];
    if (!userRow) {
      const adjacent = [calculatedPage - 1, calculatedPage + 1].filter(page => page >= 1 && page <= MINI_LEAGUE_MAX_STANDINGS_PAGE);
      const probes = await Promise.all(adjacent.map(page => loadPage(leagueId, page)));
      probedPages.push(...probes);
      for (const probe of probes) {
        const found = probe.rows.find(row => row.entryId === entryId);
        if (found) { userPage = probe; userRow = found; break; }
      }
    }
    if (!userRow) throw new MiniLeagueGatewayError(502, "The connected manager is a league member but is missing from the current official standings snapshot.", "user-standing-missing", true);
    const displayPage = requestedPage === undefined || requestedPage === userPage.page
      ? userPage
      : probedPages.find(page => page.page === requestedPage) ?? await loadPage(leagueId, requestedPage);
    const malformedRows = displayPage.malformedRows;
    const stale = entryRead.stale || bootstrapRead.stale || displayPage.stale;
    const warnings: string[] = [];
    if (malformedRows) warnings.push(`${malformedRows} malformed standings row${malformedRows === 1 ? " was" : "s were"} omitted.`);
    if (stale) warnings.push("Showing cached official data because FPL could not refresh it.");
    const result: MiniLeagueStandingsResult = {
      source: "official-fpl",
      seasonOver,
      partial: malformedRows > 0,
      league: displayPage.league,
      connectedManager: {
        entryId,
        rank: userRow.rank,
        lastRank: userRow.lastRank,
        rankChange: userRow.rankChange,
        gameweekPoints: userRow.gameweekPoints,
        totalPoints: userRow.totalPoints,
        page: userPage.page,
        leagueSize: membership.leagueSize,
      },
      standings: {
        page: displayPage.page,
        hasNext: displayPage.hasNext,
        rows: displayPage.rows.map(row => ({
          ...row,
          pointsGap: row.totalPoints - userRow!.totalPoints,
          isConnected: row.entryId === entryId,
        })),
      },
      freshness: {
        officialUpdatedAt: displayPage.officialUpdatedAt ?? userPage.officialUpdatedAt,
        fetchedAt: new Date(now()).toISOString(),
        stale,
        warnings,
      },
    };
    return deepFreeze(result);
  }

  return { loadStandings };
}

