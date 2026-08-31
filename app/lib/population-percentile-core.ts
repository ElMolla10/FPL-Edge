export type PercentileCurvePoint = Readonly<{ rank: number; points: number }>;

export type PercentileCacheRow = Readonly<{
  id: string;
  eventId: number;
  eventFinished: boolean;
  totalPlayers: number;
  curve: readonly PercentileCurvePoint[];
  omittedSamples: number;
  sampledAt: string;
}>;

export type PercentileCacheRepo = {
  read(): Promise<PercentileCacheRow | null>;
  write(row: PercentileCacheRow): Promise<void>;
};

export type PopulationPercentileResult =
  | {
      status: "available";
      eventId: number;
      eventFinished: boolean;
      totalPlayers: number;
      curve: readonly PercentileCurvePoint[];
      sampledAt: string;
      stale: boolean;
      omittedSamples: number;
    }
  | { status: "unavailable"; reason: string };

export const POPULATION_PERCENTILE_CACHE_ROW_ID = "overall";
export const POPULATION_PERCENTILE_SAMPLE_COUNT = 29;
export const POPULATION_PERCENTILE_PAGE_SIZE = 50;
// Live gameweek (matches in progress): the population's cumulative curve genuinely moves as
// results and bonus points come in across the weekend's kickoff blocks, so this refreshes often
// enough to track that without hammering the upstream (~1-2s per refresh at 29 samples).
export const POPULATION_PERCENTILE_TTL_LIVE_MS = 2 * 60 * 60 * 1000;
// finished + data_checked: FPL has confirmed the gameweek's data as final, so nothing meaningful
// changes until the next gameweek's matches start. A long TTL avoids refreshing for no reason;
// it is not zero because data_checked has occasionally been revised shortly after being set.
export const POPULATION_PERCENTILE_TTL_FINISHED_MS = 12 * 60 * 60 * 1000;

export function isPercentileCacheStale(row: PercentileCacheRow, now: number): boolean {
  const ttlMs = row.eventFinished ? POPULATION_PERCENTILE_TTL_FINISHED_MS : POPULATION_PERCENTILE_TTL_LIVE_MS;
  const age = now - Date.parse(row.sampledAt);
  return !Number.isFinite(age) || age > ttlMs;
}

/**
 * Geometric (log-spaced) page sequence from page 1 to maxPage, biased toward the top of the table
 * where the real rank<->points curve is steepest (rank 1 to a few hundred thousand covers a much
 * larger point-value range than the long, flat tail below it). Boundaries land exactly on 1 and
 * maxPage; near-adjacent low-index steps can round to the same page and are de-duplicated, so the
 * returned length can be slightly below sampleCount.
 */
export function logSpacedPages(maxPage: number, sampleCount: number): number[] {
  if (!Number.isInteger(maxPage) || maxPage < 1) throw new Error("maxPage must be a positive integer.");
  if (!Number.isInteger(sampleCount) || sampleCount < 2) throw new Error("sampleCount must be an integer of at least 2.");
  if (maxPage === 1) return [1];
  const logMax = Math.log(maxPage);
  const pages = new Set<number>();
  for (let index = 0; index < sampleCount; index++) {
    const t = index / (sampleCount - 1);
    pages.add(Math.max(1, Math.min(maxPage, Math.round(Math.exp(t * logMax)))));
  }
  return [...pages].sort((a, b) => a - b);
}

/**
 * Skips unusable samples (a page that came back empty, or a malformed rank/points pair) rather
 * than failing the whole refresh over one bad sample point -- same disclosure philosophy as
 * Mini-League's malformedRows: omit, count, and report, don't silently drop or hard-fail.
 */
export function buildCurveFromSamples(samples: readonly (PercentileCurvePoint | null)[]): {
  curve: PercentileCurvePoint[];
  omittedSamples: number;
} {
  const curve: PercentileCurvePoint[] = [];
  let omittedSamples = 0;
  for (const sample of samples) {
    if (!sample || !Number.isInteger(sample.rank) || sample.rank < 1 || !Number.isFinite(sample.points) || sample.points < 0) {
      omittedSamples++;
      continue;
    }
    curve.push({ rank: sample.rank, points: sample.points });
  }
  curve.sort((a, b) => a.rank - b.rank);
  return { curve, omittedSamples };
}

// Concurrency gating is deliberately NOT done here: it belongs to whatever real I/O `fetchPage`
// performs (the wiring layer's fetchPage already routes through fetchWithTimeout's own limiter).
// Wrapping these calls in a second limiter here, on top of that one, would nest one limiter.run()
// inside another -- if both used the same shared limiter instance, an outer slot could sit occupied
// waiting on an inner call that can never acquire its own slot from the same exhausted limiter.
export async function sampleOverallCurve(input: {
  maxPage: number;
  sampleCount: number;
  fetchPage: (page: number) => Promise<PercentileCurvePoint | null>;
}): Promise<{ curve: PercentileCurvePoint[]; omittedSamples: number }> {
  const pages = logSpacedPages(input.maxPage, input.sampleCount);
  const samples = await Promise.all(pages.map(page => input.fetchPage(page)));
  return buildCurveFromSamples(samples);
}

const rowToResult = (row: PercentileCacheRow, stale: boolean): PopulationPercentileResult => ({
  status: "available",
  eventId: row.eventId,
  eventFinished: row.eventFinished,
  totalPlayers: row.totalPlayers,
  curve: row.curve,
  sampledAt: row.sampledAt,
  omittedSamples: row.omittedSamples,
  stale,
});

/**
 * Blocking stale-check-and-refresh, matching Mini-League's gateway philosophy exactly: the request
 * that finds the cache stale or missing pays the live-sampling cost itself (no background
 * revalidation), every other request within the TTL window just reads the cached row. A refresh
 * failure falls back to the existing stale row (marked stale, never silently presented as fresh);
 * only a first-ever refresh with no prior row at all surfaces as unavailable.
 */
export async function getPopulationPercentiles(deps: {
  repo: PercentileCacheRepo;
  now: () => number;
  fetchCurrentEvent: () => Promise<{ eventId: number; eventFinished: boolean; totalPlayers: number }>;
  fetchPage: (page: number) => Promise<PercentileCurvePoint | null>;
  sampleCount?: number;
}): Promise<PopulationPercentileResult> {
  const sampleCount = deps.sampleCount ?? POPULATION_PERCENTILE_SAMPLE_COUNT;
  const cached = await deps.repo.read();
  if (cached && !isPercentileCacheStale(cached, deps.now())) return rowToResult(cached, false);
  try {
    const { eventId, eventFinished, totalPlayers } = await deps.fetchCurrentEvent();
    const maxPage = Math.max(1, Math.ceil(totalPlayers / POPULATION_PERCENTILE_PAGE_SIZE));
    const { curve, omittedSamples } = await sampleOverallCurve({
      maxPage, sampleCount, fetchPage: deps.fetchPage,
    });
    if (!curve.length) throw new Error("No usable population standings samples were returned.");
    const row: PercentileCacheRow = {
      id: POPULATION_PERCENTILE_CACHE_ROW_ID,
      eventId, eventFinished, totalPlayers, curve, omittedSamples,
      sampledAt: new Date(deps.now()).toISOString(),
    };
    await deps.repo.write(row);
    return rowToResult(row, false);
  } catch (error) {
    if (cached) return rowToResult(cached, true);
    return { status: "unavailable", reason: error instanceof Error ? error.message : "Population percentile data is unavailable." };
  }
}
