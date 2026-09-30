/**
 * Request guards shared by the state-changing API routes: same-origin (CSRF) check and small
 * hand-rolled body validation. Pure (no Next/D1 imports) so they unit-test in plain Node.
 * See docs/SECURITY.md.
 */

// ---------------------------------------------------------------- CSRF -------------------------

/**
 * Defence in depth on top of the SameSite=Lax session cookie: reject state-changing requests that
 * a browser says came from another site.
 *
 * Decision order:
 *  1. Sec-Fetch-Site: "same-origin" -> allow; "cross-site" | "same-site" -> reject
 *     ("same-site" = a sibling subdomain, which is not this app); "none" -> allow (user-initiated,
 *     e.g. typed URL / bookmark).
 *  2. Origin header present -> must equal the request's own origin (protocol+host).
 *  3. Neither header (non-browser client such as curl, or a very old browser) -> allow. Such a client
 *     cannot ride a victim's cookies cross-site, and the cookie is SameSite=Lax anyway.
 *
 * Do NOT apply to server-to-server webhooks (Paymob callback: authenticated by HMAC, no browser).
 */
export function checkSameOrigin(request: Request): { ok: true } | { ok: false; reason: string } {
  const site = request.headers.get("sec-fetch-site");
  if (site) {
    const value = site.toLowerCase();
    if (value === "same-origin" || value === "none") return { ok: true };
    return { ok: false, reason: `sec-fetch-site:${value}` };
  }
  const origin = request.headers.get("origin");
  if (origin) {
    let expected: string;
    try {
      expected = new URL(request.url).origin;
    } catch {
      return { ok: false, reason: "bad-request-url" };
    }
    if (origin === expected) return { ok: true };
    return { ok: false, reason: "origin-mismatch" };
  }
  return { ok: true };
}

/** Returns a 403 Response for a cross-site request, or null when the request may proceed. */
export function rejectCrossSite(request: Request): Response | null {
  const result = checkSameOrigin(request);
  if (result.ok) return null;
  return Response.json({ error: "Cross-site request blocked." }, { status: 403, headers: { "Cache-Control": "no-store" } });
}

// ---------------------------------------------------------------- Body parsing -----------------

export const MAX_JSON_BODY_BYTES = 64 * 1024;
/** /api/squad carries plans + locks + manager blobs; still bounded. */
export const MAX_SQUAD_BODY_BYTES = 1024 * 1024;

export class BodyError extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400) {
    super(message);
  }
}

/** Read + parse a JSON body with a hard size cap. Throws BodyError (400 / 413). */
export async function readJsonBody(request: Request, maxBytes: number = MAX_JSON_BODY_BYTES): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Release the unread upload instead of leaving the connection with a half-read body.
    await request.body?.cancel().catch(() => undefined);
    throw new BodyError("Request body is too large.", 413);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new BodyError("Request body is too large.", 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new BodyError("Invalid JSON body.");
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function bodyErrorResponse(error: unknown): Response | null {
  if (error instanceof BodyError) return Response.json({ error: error.message }, { status: error.status });
  return null;
}

/** Body must be a JSON object; each named field, if present, must be a string of at most maxLen chars. */
export function parseStringFields<K extends string>(body: unknown, fields: Record<K, number>): Partial<Record<K, string>> {
  if (!isPlainObject(body)) throw new BodyError("Request body must be a JSON object.");
  const out: Partial<Record<K, string>> = {};
  for (const [key, maxLen] of Object.entries(fields) as Array<[K, number]>) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") throw new BodyError(`"${key}" must be a string.`);
    if (value.length > maxLen) throw new BodyError(`"${key}" is too long.`);
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------- Squad payload ----------------

export const SQUAD_LIMITS = {
  squadIds: 20,
  watchlist: 500,
  locks: 60,
  captainViceEvents: 60,
  plannedChips: 4,
  plans: 4,
  maxPlayerId: 100_000,
  maxEvent: 100,
  entryMaxLen: 16,
  managerJsonBytes: 64 * 1024,
  blobJsonBytes: 900 * 1024, // locks embed frozen projection receipts; D1 rows cap at 2 MB
} as const;

function isPlayerId(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= SQUAD_LIMITS.maxPlayerId;
}
function idArray(name: string, value: unknown, max: number): number[] {
  if (!Array.isArray(value)) throw new BodyError(`"${name}" must be an array.`);
  if (value.length > max) throw new BodyError(`"${name}" has too many entries.`);
  for (const v of value) if (!isPlayerId(v)) throw new BodyError(`"${name}" must contain only player ids.`);
  return value as number[];
}
function jsonSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
}

export type SquadBody = {
  squadIds?: number[];
  watchlist?: number[];
  locks?: unknown[];
  captainVice?: Record<string, { captainId?: number; viceId?: number }>;
  entry?: string | null;
  manager?: unknown | null;
  plans?: unknown[];
  plannedChips?: unknown[];
};

/**
 * Validates the shape/size of a PUT /api/squad body. Every field is optional (unchanged from before:
 * omitted -> default). Plans/locks/manager are opaque client-owned JSON blobs: we check type + size
 * only, exactly like the previous behaviour (they were stored verbatim), never their inner schema.
 */
export function parseSquadBody(body: unknown): SquadBody {
  if (!isPlainObject(body)) throw new BodyError("Request body must be a JSON object.");
  const out: SquadBody = {};
  if (body.squadIds !== undefined) out.squadIds = idArray("squadIds", body.squadIds, SQUAD_LIMITS.squadIds);
  if (body.watchlist !== undefined) out.watchlist = idArray("watchlist", body.watchlist, SQUAD_LIMITS.watchlist);
  if (body.locks !== undefined) {
    if (!Array.isArray(body.locks)) throw new BodyError('"locks" must be an array.');
    if (body.locks.length > SQUAD_LIMITS.locks) throw new BodyError('"locks" has too many entries.');
    if (jsonSize(body.locks) > SQUAD_LIMITS.blobJsonBytes) throw new BodyError('"locks" is too large.');
    out.locks = body.locks;
  }
  if (body.captainVice !== undefined) {
    if (!isPlainObject(body.captainVice)) throw new BodyError('"captainVice" must be an object.');
    const entries = Object.entries(body.captainVice);
    if (entries.length > SQUAD_LIMITS.captainViceEvents) throw new BodyError('"captainVice" has too many entries.');
    const cv: Record<string, { captainId?: number; viceId?: number }> = {};
    for (const [event, pick] of entries) {
      if (!/^\d{1,3}$/.test(event)) throw new BodyError('"captainVice" keys must be gameweek numbers.');
      if (!isPlainObject(pick)) throw new BodyError('"captainVice" values must be objects.');
      const next: { captainId?: number; viceId?: number } = {};
      for (const k of ["captainId", "viceId"] as const) {
        const v = pick[k];
        if (v === undefined) continue;
        // 0 / NaN can be produced by the client's Number(localStorage...) for a cleared pick; hydrate ignores falsy ids.
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > SQUAD_LIMITS.maxPlayerId) throw new BodyError(`"captainVice" ${k} must be a player id.`);
        next[k] = v;
      }
      cv[event] = next;
    }
    out.captainVice = cv;
  }
  if (body.entry !== undefined && body.entry !== null) {
    if (typeof body.entry !== "string" || !/^\d{0,16}$/.test(body.entry)) throw new BodyError('"entry" must be a numeric team id string.');
    out.entry = body.entry;
  } else if (body.entry === null) out.entry = null;
  if (body.manager !== undefined && body.manager !== null) {
    if (!isPlainObject(body.manager)) throw new BodyError('"manager" must be an object.');
    if (jsonSize(body.manager) > SQUAD_LIMITS.managerJsonBytes) throw new BodyError('"manager" is too large.');
    out.manager = body.manager;
  } else if (body.manager === null) out.manager = null;
  for (const key of ["plans", "plannedChips"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) throw new BodyError(`"${key}" must be an array.`);
    // Server clamps to MAX_PLANS / MAX_PLANNED_CHIPS (slice) as before; only reject absurd payloads here.
    if (value.length > 200) throw new BodyError(`"${key}" has too many entries.`);
    if (jsonSize(value) > SQUAD_LIMITS.blobJsonBytes) throw new BodyError(`"${key}" is too large.`);
    for (const item of value) if (!isPlainObject(item)) throw new BodyError(`"${key}" must contain objects.`);
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------- Transfer execute -------------

export type TransferExecuteBody = {
  elementOut: number;
  elementIn: number;
  event: number;
  purchasePriceTenths: number;
  confirmed: boolean;
};

/** All four numbers must be positive, finite, integral JSON numbers (previously Number() coerced strings/junk). */
export function parseTransferExecuteBody(body: unknown): TransferExecuteBody {
  if (!isPlainObject(body)) throw new BodyError("Request body must be a JSON object.");
  const num = (key: string, max: number): number => {
    const raw = body[key];
    // Accept numeric strings too: the pre-existing handler used Number(), keep valid-request behaviour.
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" && raw.length <= 12 ? Number(raw) : NaN;
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > max) {
      throw new BodyError("elementOut, elementIn, event, and purchasePriceTenths are required.");
    }
    return n;
  };
  if (body.confirmed !== undefined && typeof body.confirmed !== "boolean") throw new BodyError('"confirmed" must be a boolean.');
  return {
    elementOut: num("elementOut", SQUAD_LIMITS.maxPlayerId),
    elementIn: num("elementIn", SQUAD_LIMITS.maxPlayerId),
    event: num("event", SQUAD_LIMITS.maxEvent),
    purchasePriceTenths: num("purchasePriceTenths", 10_000),
    confirmed: body.confirmed === true,
  };
}
