import { eq } from "drizzle-orm";
import { getDb, isMissingTableError } from "../../../db";
import { squadData } from "../../../db/schema";
import { getCurrentUser } from "../../lib/auth";
import { MAX_PLANS, PersistedPlan } from "../../lib/strategy-plans";
import { PlannedChip } from "../../lib/chip-portfolio";

// One row per chip name is the real invariant (see chip-portfolio.ts's planChip) -- this is just
// the same server-side defensive clamp MAX_PLANS already gets, so a stale tab or a manual API call
// can't write more than one planned entry per chip.
const MAX_PLANNED_CHIPS = 4;

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });

    const db = await getDb();
    const [row] = await db.select().from(squadData).where(eq(squadData.userId, user.id)).limit(1);
    return Response.json({
      squadIds: row ? JSON.parse(row.squadIds) : [],
      watchlist: row ? JSON.parse(row.watchlist) : [],
      locks: row ? JSON.parse(row.locks) : [],
      captainVice: row ? JSON.parse(row.captainVice) : {},
      entry: row?.entry ?? null,
      manager: row?.manager ? JSON.parse(row.manager) : null,
      plans: row ? JSON.parse(row.plans) : [],
      plannedChips: row ? JSON.parse(row.plannedChips) : [],
    });
  } catch (error) {
    console.error("squad GET error:", error);
    if (isMissingTableError(error)) {
      return Response.json({ error: "The database schema isn't set up yet. Apply the migration (see README.md) and try again." }, { status: 503 });
    }
    return Response.json({ error: "Could not load squad data." }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });

    const body = (await request.json()) as {
      squadIds?: number[];
      watchlist?: number[];
      locks?: unknown[];
      captainVice?: Record<string, { captainId?: number; viceId?: number }>;
      entry?: string | null;
      manager?: unknown | null;
      plans?: PersistedPlan[];
      plannedChips?: PlannedChip[];
    };

    const db = await getDb();
    const now = new Date().toISOString();
    const values = {
      squadIds: JSON.stringify(body.squadIds ?? []),
      watchlist: JSON.stringify(body.watchlist ?? []),
      locks: JSON.stringify(body.locks ?? []),
      captainVice: JSON.stringify(body.captainVice ?? {}),
      entry: body.entry ?? null,
      manager: body.manager ? JSON.stringify(body.manager) : null,
      // Clamped server-side regardless of what the client sent -- a stale tab or a manual API call
      // must not be able to write more than MAX_PLANS into this row.
      plans: JSON.stringify((body.plans ?? []).slice(0, MAX_PLANS)),
      plannedChips: JSON.stringify((body.plannedChips ?? []).slice(0, MAX_PLANNED_CHIPS)),
      updatedAt: now,
    };

    await db
      .insert(squadData)
      .values({ userId: user.id, ...values })
      .onConflictDoUpdate({ target: squadData.userId, set: values });

    return Response.json({ ok: true });
  } catch (error) {
    console.error("squad PUT error:", error);
    if (isMissingTableError(error)) {
      return Response.json({ error: "The database schema isn't set up yet. Apply the migration (see README.md) and try again." }, { status: 503 });
    }
    return Response.json({ error: "Could not save squad data." }, { status: 500 });
  }
}
