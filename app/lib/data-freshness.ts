/**
 * Separate Edge recalculation age from official FPL fetch age.
 * /api/fpl edge-caches ~5 minutes (s-maxage) and may serve stale-while-revalidate up to +10m —
 * never claim "just now" as if the feed were live.
 */

export const FPL_EDGE_CACHE_MAX_AGE_SECONDS = 300;
/** Matches Cache-Control stale-while-revalidate on /api/fpl. */
export const FPL_EDGE_STALE_WHILE_REVALIDATE_SECONDS = 600;

export type FreshnessTone = "fresh" | "aging" | "stale";

export type DataFreshness = {
  edgeCalculatedAt: string;
  officialFetchedAt: string | null;
  cacheMaxAgeSeconds: number;
  staleWhileRevalidateSeconds: number;
  edgeAgeMinutes: number;
  officialAgeMinutes: number | null;
  /** Conservative age for warnings: max(edge, official, and cache floor when official unknown). */
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
  staleWhileRevalidateSeconds?: number;
  nowMs?: number;
}): DataFreshness {
  const nowMs = input.nowMs ?? Date.now();
  const cacheMaxAgeSeconds = input.cacheMaxAgeSeconds ?? FPL_EDGE_CACHE_MAX_AGE_SECONDS;
  const staleWhileRevalidateSeconds =
    input.staleWhileRevalidateSeconds ?? FPL_EDGE_STALE_WHILE_REVALIDATE_SECONDS;
  const edgeCalculatedAt = input.edgeCalculatedAt;
  // Do NOT fall back official → edge: that falsely claims official was fetched at recalculation time.
  const officialRaw = input.officialFetchedAt?.trim() || null;
  const officialFetchedAt =
    officialRaw && Number.isFinite(Date.parse(officialRaw)) ? officialRaw : null;
  const edgeAgeMinutes = ageMinutes(edgeCalculatedAt, nowMs);
  const officialAgeMinutes = officialFetchedAt != null ? ageMinutes(officialFetchedAt, nowMs) : null;
  const cacheFloorMinutes = Math.floor(cacheMaxAgeSeconds / 60);
  const staleWindowMinutes = Math.floor(staleWhileRevalidateSeconds / 60);
  // When official timestamp is missing, floor by cache max-age so we do not imply a live feed.
  const effectiveAgeMinutes = Math.max(
    edgeAgeMinutes,
    officialAgeMinutes ?? cacheFloorMinutes,
  );
  const toneBasis = Math.max(edgeAgeMinutes, officialAgeMinutes ?? cacheFloorMinutes);
  const tone: FreshnessTone =
    toneBasis <= 10 ? "fresh" : toneBasis <= 30 ? "aging" : "stale";
  const edgeLabel = formatAgeMinutes(edgeAgeMinutes);
  const officialLabel =
    officialAgeMinutes != null ? formatAgeMinutes(officialAgeMinutes) : "fetch time unknown";
  const summaryLabel = `Edge ${edgeLabel} · Official ${officialLabel} · cache ≤${cacheFloorMinutes}m (+${staleWindowMinutes}m stale)`;
  return {
    edgeCalculatedAt,
    officialFetchedAt,
    cacheMaxAgeSeconds,
    staleWhileRevalidateSeconds,
    edgeAgeMinutes,
    officialAgeMinutes,
    effectiveAgeMinutes,
    edgeLabel,
    officialLabel,
    summaryLabel,
    tone,
  };
}

/**
 * Best-effort "when was upstream actually retrieved?" from Response headers.
 * Falls back to `fallbackMs` when Date/Age are absent (common on some upstreams).
 */
export function officialFetchedAtFromResponses(
  responses: Response[],
  fallbackMs: number = Date.now(),
): string {
  let earliest = fallbackMs;
  for (const response of responses) {
    let candidate = fallbackMs;
    const dateHeader = response.headers.get("date");
    if (dateHeader) {
      const parsed = Date.parse(dateHeader);
      if (Number.isFinite(parsed)) candidate = parsed;
    }
    const ageHeader = response.headers.get("age");
    if (ageHeader != null && ageHeader !== "") {
      const ageSec = Number(ageHeader);
      if (Number.isFinite(ageSec) && ageSec >= 0) {
        candidate = Math.min(candidate, Date.now() - ageSec * 1000);
      }
    }
    earliest = Math.min(earliest, candidate);
  }
  return new Date(earliest).toISOString();
}
