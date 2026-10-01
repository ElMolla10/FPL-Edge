import { getDb, isMissingTableError } from "../../db";
import { telemetryEvents } from "../../db/schema";
import { hashUserId, telemetryRow, type SanitizedTelemetry } from "./telemetry";

/** Insert one sanitized event. Swallows failures — telemetry must never break a user request. */
export async function insertTelemetry(event: SanitizedTelemetry, userId: string | null): Promise<boolean> {
  try {
    const db = await getDb();
    const userHash = userId ? await hashUserId(userId) : null;
    await db.insert(telemetryEvents).values(telemetryRow({ ...event, userHash, id: crypto.randomUUID(), ts: new Date().toISOString() }));
    return true;
  } catch (error) {
    if (!isMissingTableError(error)) console.error("telemetry insert failed:", error instanceof Error ? error.message : error);
    return false;
  }
}
