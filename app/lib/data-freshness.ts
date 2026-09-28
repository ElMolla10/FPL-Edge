/**
 * Separate Edge recalculation age from official FPL fetch age.
 * /api/fpl edge-caches ~5 minutes — never claim "just now" as if the feed were live.
 */

export const FPL_EDGE_CACHE_MAX_AGE_SECONDS = 300;

export type FreshnessTone = "fresh" | "aging" | "stale";

export type DataFreshness = {
  edgeCalculatedAt: string;
  officialFetchedAt: string;
  cacheMaxAgeSeconds: number;
  edgeAgeMinutes: number;
  officialAgeMinutes: number;
  /** Conservative age for warnings: max(edge, official) floored by cache. */
  effectiveAgeMinutes: number;
  edgeLabel: string;
  officialLabel: string;
  summaryLabel: string;
  tone: FreshnessTone;
};

function ageMinutes(iso: string, nowMs: number): number {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor((nowMs - parsed) / 60000));
}

function formatAgeMinutes(minutes: number): string {
  if (minutes < 1) return "<1m ago";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function computeDataFreshness(input: {
  edgeCalculatedAt: string;
  officialFetchedAt?: string | null;
  cacheMaxAgeSeconds?: number;
  nowMs?: number;
}): DataFreshness {
  const nowMs = input.nowMs ?? Date.now();
  const cacheMaxAgeSeconds = input.cacheMaxAgeSeconds ?? FPL_EDGE_CACHE_MAX_AGE_SECONDS;
  const edgeCalculatedAt = input.edgeCalculatedAt;
  const officialFetchedAt = input.officialFetchedAt || edgeCalculatedAt;
  const edgeAgeMinutes = ageMinutes(edgeCalculatedAt, nowMs);
  const officialAgeMinutes = ageMinutes(officialFetchedAt, nowMs);
  // Cache floor: a response served from edge cache can look newer than the true rebuild cadence.
  const cacheFloorMinutes = Math.floor(cacheMaxAgeSeconds / 60);
  const effectiveAgeMinutes = Math.max(edgeAgeMinutes, officialAgeMinutes, edgeAgeMinutes === 0 ? 0 : 0);
  // Near-deadline honesty: never use "just now"; always show Edge vs official separately.
  const tone: FreshnessTone =
    Math.max(edgeAgeMinutes, officialAgeMinutes) <= 10
      ? "fresh"
      : Math.max(edgeAgeMinutes, officialAgeMinutes) <= 30
        ? "aging"
        : "stale";
  const edgeLabel = formatAgeMinutes(edgeAgeMinutes);
  const officialLabel = formatAgeMinutes(officialAgeMinutes);
  const summaryLabel = `Edge ${edgeLabel} · Official ${officialLabel} · cache ≤${cacheFloorMinutes}m`;
  return {
    edgeCalculatedAt,
    officialFetchedAt,
    cacheMaxAgeSeconds,
    edgeAgeMinutes,
    officialAgeMinutes,
    effectiveAgeMinutes: Math.max(edgeAgeMinutes, officialAgeMinutes),
    edgeLabel,
    officialLabel,
    summaryLabel,
    tone,
  };
}
