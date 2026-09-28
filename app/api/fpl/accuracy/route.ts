import { PROJECTION_MODEL_VERSION } from "../../../lib/fpl";
import { publishAccuracyPayload } from "../../../lib/model-accuracy";

/**
 * Published accuracy scaffold (no PII).
 * Personal History receipts remain the graded sample — the browser builds the full report
 * from local/D1-synced locks. Public `report` stays null (see reportNullReason) so we never
 * leak private locks; History MAE + AutoProjectionSnapshot are the user-facing surfaces.
 */
export async function GET() {
  const payload = publishAccuracyPayload(null, new Date().toISOString());
  return Response.json(
    {
      ...payload,
      currentModelVersion: PROJECTION_MODEL_VERSION,
      whereToRead: "In-app History → Model accuracy (season pass). Metrics appear after a pre-deadline lock and a finished gameweek. Public report stays null on purpose — see reportNullReason.",
      slices: ["byPosition", "byMinutesRisk", "byHorizon", "byConfidence", "modelVersion"],
    },
    { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
  );
}
