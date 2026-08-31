import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { populationPercentiles } from "../../db/schema";
import { type ConcurrencyLimiter, type FetchLike, createConcurrencyLimiter, fetchWithTimeout } from "./fpl-gateway";
import {
  POPULATION_PERCENTILE_CACHE_ROW_ID,
  getPopulationPercentiles as getPopulationPercentilesWith,
} from "./population-percentile-core";
import type { PercentileCacheRepo, PercentileCacheRow, PercentileCurvePoint } from "./population-percentile-core";

export {
  POPULATION_PERCENTILE_SAMPLE_COUNT,
  POPULATION_PERCENTILE_TTL_FINISHED_MS,
  POPULATION_PERCENTILE_TTL_LIVE_MS,
} from "./population-percentile-core";
export type { PercentileCurvePoint, PopulationPercentileResult } from "./population-percentile-core";

const FPL = "https://fantasy.premierleague.com/api";
const OVERALL_LEAGUE_ID = 314;
const TIMEOUT_MS = 8_000;
const MAX_CONCURRENCY = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function makeD1PercentileRepo(): PercentileCacheRepo {
  return {
    async read() {
      const db = await getDb();
      const [row] = await db.select().from(populationPercentiles)
        .where(eq(populationPercentiles.id, POPULATION_PERCENTILE_CACHE_ROW_ID)).limit(1);
      if (!row) return null;
      let curve: PercentileCurvePoint[];
      try { curve = JSON.parse(row.curve); }
      catch { return null; }
      if (!Array.isArray(curve)) return null;
      return {
        id: row.id, eventId: row.eventId, eventFinished: row.eventFinished,
        totalPlayers: row.totalPlayers, curve, omittedSamples: row.omittedSamples, sampledAt: row.sampledAt,
      };
    },
    async write(row: PercentileCacheRow) {
      const db = await getDb();
      const values = {
        id: row.id, eventId: row.eventId, eventFinished: row.eventFinished,
        totalPlayers: row.totalPlayers, curve: JSON.stringify(row.curve),
        omittedSamples: row.omittedSamples, sampledAt: row.sampledAt,
      };
      await db.insert(populationPercentiles).values(values)
        .onConflictDoUpdate({ target: populationPercentiles.id, set: values });
    },
  };
}

// One limiter per refresh: shared across the bootstrap fetch and every sampled standings page, so
// the max-3-concurrent budget applies to the whole batch, not per call (see population-percentile-
// core.ts's sampleOverallCurve comment for why this must not also be gated a second time there).
// fetcher/limiter/timeoutMs are overridable (mirroring mini-league-server.ts's GatewayOptions
// pattern) so this parsing/validation logic is directly testable with a fake fetcher, not just
// exercised indirectly through a real network call.
export function makeLiveDependencies(options: { fetcher?: FetchLike; limiter?: ConcurrencyLimiter; timeoutMs?: number } = {}) {
  const fetcher = options.fetcher ?? fetch;
  const limiter = options.limiter ?? createConcurrencyLimiter(MAX_CONCURRENCY);
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  return {
    async fetchCurrentEvent(): Promise<{ eventId: number; eventFinished: boolean; totalPlayers: number }> {
      const response = await fetchWithTimeout(`${FPL}/bootstrap-static/`, { fetcher, limiter, timeoutMs });
      if (!response.ok) throw new Error(`Official FPL bootstrap-static request failed with status ${response.status}.`);
      const data: unknown = await response.json();
      if (!isRecord(data) || !Array.isArray(data.events) || typeof data.total_players !== "number") {
        throw new Error("Official FPL returned malformed bootstrap-static data.");
      }
      const current = data.events.find(event => isRecord(event) && event.is_current === true);
      if (!isRecord(current) || typeof current.id !== "number" || typeof current.finished !== "boolean") {
        throw new Error("Official FPL bootstrap-static has no current event yet.");
      }
      return { eventId: current.id, eventFinished: current.finished, totalPlayers: data.total_players };
    },
    async fetchPage(page: number): Promise<PercentileCurvePoint | null> {
      try {
        const response = await fetchWithTimeout(
          `${FPL}/leagues-classic/${OVERALL_LEAGUE_ID}/standings/?page_standings=${page}`,
          { fetcher, limiter, timeoutMs },
        );
        if (!response.ok) return null;
        const data: unknown = await response.json();
        if (!isRecord(data) || !isRecord(data.standings) || !Array.isArray(data.standings.results)) return null;
        const first = data.standings.results[0];
        if (!isRecord(first) || typeof first.rank !== "number" || typeof first.total !== "number") return null;
        return { rank: first.rank, points: first.total };
      } catch {
        // A single page's failure or timeout is omitted (see buildCurveFromSamples), not fatal to
        // the whole refresh -- the other ~28 samples still produce a usable curve.
        return null;
      }
    },
  };
}

export async function getPopulationPercentileCurve() {
  return getPopulationPercentilesWith({
    repo: makeD1PercentileRepo(),
    now: Date.now,
    ...makeLiveDependencies(),
  });
}
