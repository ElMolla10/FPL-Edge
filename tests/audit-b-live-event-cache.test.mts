import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  FINAL_EVENT_TTL_SECONDS,
  LIVE_EVENT_TTL_SECONDS,
  SETTLING_EVENT_TTL_SECONDS,
  fetchLiveEventPayload,
  liveEventCacheKey,
  liveEventClass,
  liveEventTtlSeconds,
  type CacheLike,
} from "../app/lib/live-event-cache.ts";

function harness(initialNow = 1_000_000) {
  let now = initialNow;
  let version = 1;
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ elements: [{ id: 1, stats: { total_points: version } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const store = new Map<string, Response>();
  const cache: CacheLike = {
    async match(request) { return store.get(request.url)?.clone(); },
    async put(request, response) { store.set(request.url, response); },
  };
  return {
    calls, fetchImpl, cache, store,
    memory: new Map(), inflight: new Map(),
    now: () => now,
    advance(seconds: number) { now += seconds * 1000; },
    bump() { version += 1; },
  };
}
const opts = (h: ReturnType<typeof harness>, extra: object = {}) => ({ fetchImpl: h.fetchImpl, cache: null, now: h.now, memory: h.memory, inflight: h.inflight, ...extra });
const points = (payload: unknown) => (payload as { elements: { stats: { total_points: number } }[] }).elements[0].stats.total_points;

test("event classes and TTL ordering", () => {
  assert.equal(liveEventClass({ finished: true, dataChecked: true }), "final");
  assert.equal(liveEventClass({ finished: true, dataChecked: false }), "settling");
  assert.equal(liveEventClass({ finished: false, dataChecked: false }), "live");
  assert.equal(liveEventClass({}), "live");
  assert.ok(LIVE_EVENT_TTL_SECONDS <= 60);
  assert.ok(LIVE_EVENT_TTL_SECONDS < SETTLING_EVENT_TTL_SECONDS && SETTLING_EVENT_TTL_SECONDS < FINAL_EVENT_TTL_SECONDS);
  assert.equal(liveEventTtlSeconds("final"), FINAL_EVENT_TTL_SECONDS);
});

test("finished gameweeks are not re-fetched inside the long TTL", async () => {
  const h = harness();
  const ev = { id: 3, finished: true, dataChecked: true };
  assert.equal(points(await fetchLiveEventPayload(ev, opts(h))), 1);
  h.bump(); h.advance(3600);
  assert.equal(points(await fetchLiveEventPayload(ev, opts(h))), 1);
  assert.equal(h.calls.length, 1);
  h.advance(FINAL_EVENT_TTL_SECONDS);
  assert.equal(points(await fetchLiveEventPayload(ev, opts(h))), 2);
  assert.equal(h.calls.length, 2);
});

test("the live gameweek is never served older than the short TTL", async () => {
  const h = harness();
  const ev = { id: 5, finished: false, dataChecked: false };
  await fetchLiveEventPayload(ev, opts(h));
  h.bump(); h.advance(LIVE_EVENT_TTL_SECONDS - 1);
  assert.equal(points(await fetchLiveEventPayload(ev, opts(h))), 1);
  h.advance(2);
  assert.equal(points(await fetchLiveEventPayload(ev, opts(h))), 2, "must refetch once the short TTL elapsed");
  assert.equal(h.calls.length, 2);
});

test("an entry captured while live is not promoted to the long TTL after the gameweek finishes", async () => {
  const h = harness();
  await fetchLiveEventPayload({ id: 5, finished: false, dataChecked: false }, opts(h));
  h.bump(); h.advance(LIVE_EVENT_TTL_SECONDS + 5);
  const after = await fetchLiveEventPayload({ id: 5, finished: true, dataChecked: true }, opts(h));
  assert.equal(points(after), 2);
});

test("an entry cached as final is not kept when the event is reported live again", async () => {
  const h = harness();
  await fetchLiveEventPayload({ id: 4, finished: true, dataChecked: true }, opts(h));
  h.bump(); h.advance(LIVE_EVENT_TTL_SECONDS + 5);
  assert.equal(points(await fetchLiveEventPayload({ id: 4, finished: false }, opts(h))), 2);
});

test("concurrent requests share one upstream fetch", async () => {
  const h = harness();
  const ev = { id: 2, finished: true, dataChecked: true };
  await Promise.all([1, 2, 3].map(() => fetchLiveEventPayload(ev, opts(h))));
  assert.equal(h.calls.length, 1);
});

test("upstream errors and unparseable bodies throw and are not cached", async () => {
  const h = harness();
  const bad = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(fetchLiveEventPayload({ id: 1, finished: true, dataChecked: true }, opts(h, { fetchImpl: bad })), /GW1 returned 503/);
  const junk = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(fetchLiveEventPayload({ id: 1, finished: true, dataChecked: true }, opts(h, { fetchImpl: junk })));
  assert.equal(h.memory.size, 0);
  assert.equal(points(await fetchLiveEventPayload({ id: 1, finished: true, dataChecked: true }, opts(h))), 1);
});

test("shared Cache API layer: hit avoids upstream, stale live entry is ignored, key is synthetic", async () => {
  const h = harness();
  const writes: Promise<unknown>[] = [];
  const ev = { id: 5, finished: false, dataChecked: false };
  await fetchLiveEventPayload(ev, opts(h, { cache: h.cache, waitUntil: (p: Promise<unknown>) => writes.push(p) }));
  await Promise.all(writes);
  assert.deepEqual([...h.store.keys()], [liveEventCacheKey(5).url]);
  assert.match([...h.store.keys()][0], /^https:\/\/fpl-edge-cache\.internal\/event-live\/5/);
  // a different isolate (fresh memory) inside the TTL hits the shared cache
  h.bump(); h.advance(10);
  const other = { ...opts(h, { cache: h.cache }), memory: new Map(), inflight: new Map() };
  assert.equal(points(await fetchLiveEventPayload(ev, other)), 1);
  assert.equal(h.calls.length, 1);
  // beyond the short TTL the shared entry is not served for the live gameweek
  h.advance(LIVE_EVENT_TTL_SECONDS);
  const third = { ...opts(h, { cache: h.cache }), memory: new Map(), inflight: new Map() };
  assert.equal(points(await fetchLiveEventPayload(ev, third)), 2);
  assert.equal(h.calls.length, 2);
});

test("only public, non-personal request data is sent or stored", async () => {
  const h = harness();
  const writes: Promise<unknown>[] = [];
  await fetchLiveEventPayload({ id: 1, finished: true, dataChecked: true }, opts(h, { cache: h.cache, waitUntil: (p: Promise<unknown>) => writes.push(p) }));
  await Promise.all(writes);
  const sent = JSON.stringify(h.calls[0].init?.headers ?? {}).toLowerCase();
  assert.doesNotMatch(sent, /cookie|authorization|token|session/);
  const stored = [...h.store.values()][0];
  assert.equal(stored.headers.get("set-cookie"), null);
  assert.match(stored.headers.get("cache-control") ?? "", /^public, max-age=\d+$/);
  const source = readFileSync(new URL("../app/lib/live-event-cache.ts", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(source, /request\.headers|cookies?\(|Authorization/);
});

test("/api/fpl uses the live-event cache and personal routes do not", () => {
  const route = readFileSync(new URL("../app/api/fpl/route.ts", import.meta.url), "utf8");
  assert.match(route, /fetchLiveEventPayload\(/);
  assert.doesNotMatch(route, /event\/\$\{event\.id\}\/live/);
  for (const file of ["team", "league", "history", "chips", "accuracy"]) {
    const personal = readFileSync(new URL(`../app/api/fpl/${file}/route.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(personal, /live-event-cache/, `${file} must not share the public live cache`);
  }
});
