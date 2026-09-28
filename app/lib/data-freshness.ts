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
 * Returns null when a response provides neither usable Date nor Age evidence; the
 * handler's current time is not evidence of when the official feed was fetched.
 */
export function officialFetchedAtFromResponses(
  responses: Response[],
  nowMs: number = Date.now(),
): string | null {
  let earliest: number | null = null;
  for (const response of responses) {
    const dateHeader = response.headers.get("date");
    const parsedDate = dateHeader ? Date.parse(dateHeader) : Number.NaN;
    const ageHeader = response.headers.get("age");
    const ageSec = ageHeader != null && ageHeader !== "" ? Number(ageHeader) : Number.NaN;
    const hasUsableDate = Number.isFinite(parsedDate);
    const hasUsableAge = Number.isFinite(ageSec) && ageSec >= 0;
    if (!hasUsableDate && !hasUsableAge) continue;

    const ageDerived = nowMs - ageSec * 1000;
    const candidate = hasUsableAge
      ? hasUsableDate
        ? Math.min(parsedDate, ageDerived)
        : ageDerived
      : parsedDate;
    earliest = earliest == null ? candidate : Math.min(earliest, candidate);
  }
  return earliest == null ? null : new Date(earliest).toISOString();
}


/**
 * Public UX: binary connection chip only (Connected / Not connected).
 * Detailed Edge/Official/cache ages stay on computeDataFreshness.summaryLabel for ?debug=1.
 *
 * Connected = usable Edge payload is loaded (players present, no load failure).
 * Not connected = no usable data (still loading failure, empty pool, or explicit error).
 * Age/stale alone does NOT flip to Not connected — that would revive jargon-driven UX.
 */
export type PublicConnectionStatus = "connected" | "not_connected";

export function publicConnectionStatus(input: {
  hasUsableData: boolean;
  loadFailed?: boolean;
}): { status: PublicConnectionStatus; label: "Connected" | "Not connected"; tone: "fresh" | "stale" } {
  const ok = input.hasUsableData && !input.loadFailed;
  return ok
    ? { status: "connected", label: "Connected", tone: "fresh" }
    : { status: "not_connected", label: "Not connected", tone: "stale" };
}

/** Least-invasive internal path: ?debug=1 exposes Edge/Official/cache detail. */
export function isDataFreshnessDebug(search: string = ""): boolean {
  try {
    const raw = search.startsWith("?") ? search.slice(1) : search;
    return new URLSearchParams(raw).get("debug") === "1";
  } catch {
    return false;
  }
}
