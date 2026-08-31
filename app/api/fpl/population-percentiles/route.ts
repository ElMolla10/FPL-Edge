import { getPopulationPercentileCurve } from "../../../lib/population-percentile";
import type { PopulationPercentileResult } from "../../../lib/population-percentile";

type PercentileService = { get(): Promise<PopulationPercentileResult> };

const service: PercentileService = { get: getPopulationPercentileCurve };

// Population-wide, identical for every caller (unlike Mini-League's per-entry data), so this is
// deliberately cacheable at the edge/browser -- "public, max-age" rather than Mini-League's
// "private, no-store" -- on top of the much longer TTL that governs the underlying D1 refresh.
export function createPopulationPercentilesRoute(svc: PercentileService) {
  return async function GET(): Promise<Response> {
    const result = await svc.get();
    if (result.status === "unavailable") {
      return Response.json({ error: result.reason }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json(result, { headers: { "Cache-Control": "public, max-age=300" } });
  };
}

export const GET = createPopulationPercentilesRoute(service);
