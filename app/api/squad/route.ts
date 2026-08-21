import { eq } from "drizzle-orm";
import { getDb, isMissingTableError } from "../../../db";
import { squadData } from "../../../db/schema";
import { getCurrentUser } from "../../lib/auth";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });

    const db = getDb();
    const [row] = await db.select().from(squadData).where(eq(squadData.userId, user.id)).limit(1);
    return Response.json({
      squadIds: row ? JSON.parse(row.squadIds) : [],
      watchlist: row ? JSON.parse(row.watchlist) : [],
      locks: row ? JSON.parse(row.locks) : [],
      captainVice: row ? JSON.parse(row.captainVice) : {},
      entry: row?.entry ?? null,
      manager: row?.manager ? JSON.parse(row.manager) : null,
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
    };

    const db = getDb();
    const now = new Date().toISOString();
    const values = {
      squadIds: JSON.stringify(body.squadIds ?? []),
      watchlist: JSON.stringify(body.watchlist ?? []),
      locks: JSON.stringify(body.locks ?? []),
      captainVice: JSON.stringify(body.captainVice ?? {}),
      entry: body.entry ?? null,
      manager: body.manager ? JSON.stringify(body.manager) : null,
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
