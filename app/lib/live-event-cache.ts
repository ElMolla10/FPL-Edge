// Cache for the public FPL `event/{id}/live/` payloads that /api/fpl aggregates.
//
// Why: /api/fpl re-downloads every started gameweek's live payload (~0.45 MB each,
// 38 by season end) on every cold render. Finished gameweeks never change, so they
// should not be re-fetched every five minutes; the live gameweek must stay fresh.
//
// Two layers, both keyed ONLY on the event id (never on cookies, headers or user data):
//   1. a bounded per-isolate memory map (works everywhere, including *.workers.dev), and
//   2. the Workers Cache API (`caches.default`) shared per data centre when it is
//      available (custom domain / route; it is a documented no-op on *.workers.dev).
//
// Safety rules enforced here:
//   - Only the public upstream JSON is stored, under a synthetic internal URL. The
//     upstream request carries just Accept + User-Agent; no Cookie/Authorization.
//   - Every entry records the freshness class it was written under. Its age is checked
//     against min(TTL of that class, TTL of the event's *current* class), so an entry
//     captured while a gameweek was live can never be promoted to the long TTL when the
//     gameweek later finishes, and a live gameweek is never served older than the short TTL.
//   - Personal endpoints (/api/fpl/team, …) do not use this module.

export type LiveEventMeta = { id: number; finished?: boolean; dataChecked?: boolean };
export type LiveEventClass = "final" | "settling" | "live";

/** Long TTL: official data-checked gameweeks are immutable. */
export const FINAL_EVENT_TTL_SECONDS = 24 * 60 * 60;
/** Finished but not yet data-checked: bonus/corrections can still land. */
export const SETTLING_EVENT_TTL_SECONDS = 10 * 60;
/** Current / in-progress gameweek: short TTL, never longer. */
export const LIVE_EVENT_TTL_SECONDS = 60;

const MEMORY_MAX_ENTRIES = 48;
const CACHE_KEY_ORIGIN = "https://fpl-edge-cache.internal";
const CACHE_KEY_VERSION = 1;
const CACHED_AT_HEADER = "x-fpl-edge-cached-at";
const CLASS_HEADER = "x-fpl-edge-event-class";

export function liveEventClass(event: { finished?: boolean; dataChecked?: boolean }): LiveEventClass {
  if (event.finished && event.dataChecked) return "final";
  if (event.finished) return "settling";
  return "live";
}

export function liveEventTtlSeconds(eventClass: LiveEventClass): number {
  return eventClass === "final" ? FINAL_EVENT_TTL_SECONDS : eventClass === "settling" ? SETTLING_EVENT_TTL_SECONDS : LIVE_EVENT_TTL_SECONDS;
}

type Entry = { text: string; cachedAt: number; eventClass: LiveEventClass };

export type CacheLike = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

export type LiveEventCacheOptions = {
  fetchImpl?: typeof fetch;
  /** Shared cache; pass `null` to disable, omit to auto-detect `caches.default`. */
  cache?: CacheLike | null;
  now?: () => number;
  waitUntil?: (promise: Promise<unknown>) => void;
  memory?: Map<number, Entry>;
  inflight?: Map<number, Promise<string>>;
  /** Upstream request headers (must stay non-personal). */
  headers?: Record<string, string>;
};

const defaultMemory = new Map<number, Entry>();
const defaultInflight = new Map<number, Promise<string>>();

export function liveEventUrl(eventId: number) {
  return `https://fantasy.premierleague.com/api/event/${eventId}/live/`;
}

export function liveEventCacheKey(eventId: number) {
  return new Request(`${CACHE_KEY_ORIGIN}/event-live/${eventId}?v=${CACHE_KEY_VERSION}`, { method: "GET" });
}

function detectCache(): CacheLike | null {
  try {
    const store = (globalThis as { caches?: { default?: CacheLike } }).caches;
    return store?.default ?? null;
  } catch {
    return null;
  }
}

function isFresh(entry: Entry, current: LiveEventClass, nowMs: number) {
  const ageSeconds = (nowMs - entry.cachedAt) / 1000;
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return false;
  return ageSeconds < Math.min(liveEventTtlSeconds(entry.eventClass), liveEventTtlSeconds(current));
}

function remember(memory: Map<number, Entry>, eventId: number, entry: Entry) {
  memory.delete(eventId);
  memory.set(eventId, entry);
  while (memory.size > MEMORY_MAX_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

async function readShared(cache: CacheLike, eventId: number): Promise<Entry | null> {
  try {
    const hit = await cache.match(liveEventCacheKey(eventId));
    if (!hit) return null;
    const cachedAt = Number(hit.headers.get(CACHED_AT_HEADER));
    const eventClass = hit.headers.get(CLASS_HEADER) as LiveEventClass | null;
    if (!Number.isFinite(cachedAt) || (eventClass !== "final" && eventClass !== "settling" && eventClass !== "live")) return null;
    return { text: await hit.text(), cachedAt, eventClass };
  } catch {
    return null;
  }
}

function writeShared(cache: CacheLike, eventId: number, entry: Entry) {
  const ttl = liveEventTtlSeconds(entry.eventClass);
  const response = new Response(entry.text, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${ttl}`,
      [CACHED_AT_HEADER]: String(entry.cachedAt),
      [CLASS_HEADER]: entry.eventClass,
    },
  });
  return cache.put(liveEventCacheKey(eventId), response).catch(() => undefined);
}

/**
 * Returns the parsed live payload for one gameweek, served from cache when still fresh
 * for its class. Throws exactly like the previous inline fetch when upstream fails.
 */
export async function fetchLiveEventPayload(event: LiveEventMeta, options: LiveEventCacheOptions = {}): Promise<unknown> {
  const now = options.now ?? Date.now;
  const memory = options.memory ?? defaultMemory;
  const inflight = options.inflight ?? defaultInflight;
  const cache = options.cache === undefined ? detectCache() : options.cache;
  const eventClass = liveEventClass({ finished: event.finished, dataChecked: event.dataChecked });

  const cachedMemory = memory.get(event.id);
  if (cachedMemory && isFresh(cachedMemory, eventClass, now())) return JSON.parse(cachedMemory.text);

  const pending = inflight.get(event.id);
  if (pending) return JSON.parse(await pending);

  const task = (async () => {
    if (cache) {
      const shared = await readShared(cache, event.id);
      if (shared && isFresh(shared, eventClass, now())) {
        remember(memory, event.id, shared);
        return shared.text;
      }
    }
    const doFetch = options.fetchImpl ?? fetch;
    // `revalidate: 0` opts out of vinext's separate 5-minute in-memory fetch cache so this
    // module is the single owner of live-payload freshness.
    const response = await doFetch(liveEventUrl(event.id), {
      headers: options.headers ?? { Accept: "application/json", "User-Agent": "FPL-Edge/1.0" },
      next: { revalidate: 0 },
    } as RequestInit);
    if (!response.ok) throw new Error(`Official FPL live stats for GW${event.id} returned ${response.status}`);
    const text = await response.text();
    JSON.parse(text); // never cache an unparseable body
    const entry: Entry = { text, cachedAt: now(), eventClass };
    remember(memory, event.id, entry);
    if (cache) {
      const write = writeShared(cache, event.id, entry);
      if (options.waitUntil) options.waitUntil(write);
      else void write;
    }
    return text;
  })();
  inflight.set(event.id, task);
  try {
    return JSON.parse(await task);
  } finally {
    inflight.delete(event.id);
  }
}
