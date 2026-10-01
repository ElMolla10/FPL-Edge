/**
 * First-party funnel telemetry — pure core (no D1/Next imports) so it unit-tests in plain Node.
 * Privacy rules: no email, squad, player names or FPL team id ever reach the table.
 * Only allow-listed event names; meta is flat primitives, allow-listed keys, short values.
 */

export const TELEMETRY_EVENTS = [
  "landing_view", "demo_open", "app_open", "signin_success", "team_connected", "call_viewed",
  "lock_created", "pay_view", "pass_activated", "notify_opt_in", "notify_opt_out",
] as const;
export type TelemetryEvent = (typeof TELEMETRY_EVENTS)[number];

/** Events where a demo (example squad) must be distinguishable from a real one. */
export const FUNNEL_SOURCE_EVENTS: ReadonlySet<TelemetryEvent> = new Set(["call_viewed", "lock_created", "pay_view", "team_connected", "app_open"]);

/** Only these meta keys are kept. Anything else (email, squad, players, entry, teamId…) is dropped. */
export const META_ALLOWED_KEYS = new Set(["source", "action", "gw", "view", "mode", "plan", "result", "ref"]);
const MAX_META_STRING = 40;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

export type TelemetryMetaValue = string | number | boolean;
export type SanitizedTelemetry = { event: TelemetryEvent; meta: Record<string, TelemetryMetaValue>; path: string | null };

export function isTelemetryEvent(value: unknown): value is TelemetryEvent {
  return typeof value === "string" && (TELEMETRY_EVENTS as readonly string[]).includes(value);
}

/** Pathname only — strips query/hash (which may carry ids) and caps length. */
export function sanitizePath(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.startsWith("/")) return null;
  const path = raw.split(/[?#]/)[0].slice(0, 80);
  return /^[\w\-/.]*$/.test(path) ? path : null;
}

export function sanitizeMeta(raw: unknown): Record<string, TelemetryMetaValue> {
  const out: Record<string, TelemetryMetaValue> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!META_ALLOWED_KEYS.has(key)) continue;
    if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = Math.round(value * 100) / 100;
    else if (typeof value === "string") {
      if (EMAIL_LIKE.test(value)) continue;
      const v = value.slice(0, MAX_META_STRING);
      if (!/^[\w\-. :|]*$/.test(v)) continue;
      out[key] = v;
    }
  }
  return out;
}

/** Validate a POST body. Returns null for unknown events / malformed bodies (caller answers 204, never 500). */
export function sanitizeTelemetry(body: unknown): SanitizedTelemetry | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (!isTelemetryEvent(b.event)) return null;
  const meta = sanitizeMeta(b.meta);
  if (b.event === "call_viewed" && meta.action !== "HOLD" && meta.action !== "MAKE") delete meta.action;
  // Demo vs real must always be filterable on funnel events: anything not explicitly "real" is not real.
  if (FUNNEL_SOURCE_EVENTS.has(b.event) && meta.source !== "real") meta.source = meta.source === "demo" ? "demo" : "unknown";
  return { event: b.event, meta, path: sanitizePath(b.path) };
}

// ------------------------------------------------------------- rate limit (per isolate) -------

export type RateWindow = { count: number; startedAt: number };
export const TELEMETRY_RATE_LIMIT = { max: 60, windowMs: 60_000 };

/** Fixed-window limiter over a Map. Returns true when the request is allowed. Never throws. */
export function allowTelemetry(store: Map<string, RateWindow>, key: string, now: number, limit = TELEMETRY_RATE_LIMIT): boolean {
  if (store.size > 5000) for (const [k, w] of store) if (now - w.startedAt >= limit.windowMs) store.delete(k);
  const w = store.get(key);
  if (!w || now - w.startedAt >= limit.windowMs) { store.set(key, { count: 1, startedAt: now }); return true; }
  w.count += 1;
  return w.count <= limit.max;
}

/** One-way, salted user id hash. Never the raw id, never the email. */
export async function hashUserId(userId: string, salt = "fpl-edge-telemetry-v1"): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}:${userId}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function telemetryRow(input: SanitizedTelemetry & { userHash: string | null; id: string; ts: string }) {
  return { id: input.id, ts: input.ts, event: input.event, userHash: input.userHash, meta: JSON.stringify(input.meta), path: input.path };
}
