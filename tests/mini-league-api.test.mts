import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundedTtlCache,
  MiniLeagueGatewayError,
  createConcurrencyLimiter,
  createMiniLeagueGateway,
  parsePositiveInteger,
} from "../app/lib/mini-league-server.ts";

const ENTRY_ID = 7;
const LEAGUE_ID = 123;

function entryPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID,
    name: "Connected XI",
    player_first_name: "Connected",
    player_last_name: "Manager",
    summary_overall_points: 99,
    summary_overall_rank: 1000,
    secret_email: "must-not-leak@example.com",
    leagues: {
      classic: [{
        id: LEAGUE_ID,
        name: "Friends League",
        scoring: "c",
        entry_rank: 51,
        entry_last_rank: 55,
        rank_count: 80,
        active_phases: [{ phase: 1, rank: 51, last_rank: 55, total: 99 }],
      }],
    },
    ...overrides,
  };
}

function bootstrapPayload(finished = false) {
  return {
    events: Array.from({ length: 38 }, (_, index) => ({
      id: index + 1,
      finished,
      deadline_time: `2026-${String(Math.min(12, index + 1)).padStart(2, "0")}-01T12:00:00Z`,
    })),
    elements: [{ id: 1, web_name: "Player" }],
  };
}

function standing(overrides: Record<string, unknown> = {}) {
  return {
    entry: ENTRY_ID,
    entry_name: "Connected XI",
    player_name: "Connected Manager",
    rank: 51,
    last_rank: 55,
    rank_sort: 51,
    event_total: 61,
    total: 99,
    club_badge_src: null,
    private_note: "must not leak",
    ...overrides,
  };
}

function standingsPayload(page: number, rows: Record<string, unknown>[], overrides: Record<string, unknown> = {}) {
  return {
    last_updated_data: "2026-08-31T09:29:18Z",
    league: {
      id: LEAGUE_ID,
      name: "Friends League",
      league_type: "x",
      scoring: "c",
      closed: false,
      start_event: 1,
      admin_entry: 999,
    },
    standings: { page, has_next: page < 2, results: rows },
    new_entries: { page: 1, has_next: false, results: [] },
    ...overrides,
  };
}

type FetchFixture = Record<string, unknown | Response | (() => Promise<Response>)>;

function fixtureFetch(fixtures: FetchFixture, calls: string[] = []) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(fixtures).find(candidate => url.includes(candidate));
    if (!key) throw new Error(`Unexpected URL ${url}`);
    const fixture = fixtures[key];
    if (typeof fixture === "function") return fixture();
    if (fixture instanceof Response) return fixture;
    if (init?.signal?.aborted) throw init.signal.reason;
    return Response.json(fixture);
  };
}

function successfulFixtures(
  pageOneRows: Record<string, unknown>[] = [standing({ entry: 8, rank: 50, last_rank: 49, total: 103 })],
  pageTwoRows: Record<string, unknown>[] = [standing()],
) {
  return {
    "/bootstrap-static/": bootstrapPayload(false),
    [`/entry/${ENTRY_ID}/`]: entryPayload(),
    "page_standings=1": standingsPayload(1, pageOneRows),
    "page_standings=2": standingsPayload(2, pageTwoRows),
  };
}

test("positive integer validation rejects zero, signs, fractions, unsafe integers, and excessive pages", () => {
  assert.equal(parsePositiveInteger("123", "league"), 123);
  for (const value of [null, "", "0", "-1", "+1", "1.5", "abc", "9007199254740992"]) {
    assert.throws(() => parsePositiveInteger(value, "league"), (error: unknown) =>
      error instanceof MiniLeagueGatewayError && error.status === 400,
    );
  }
  assert.throws(() => parsePositiveInteger("201", "page", 200), /page must be between 1 and 200/i);
});

test("gateway verifies membership, locates the user page, signs gaps, and whitelists every field", async () => {
  const gateway = createMiniLeagueGateway({
    fetcher: fixtureFetch(successfulFixtures()),
    now: () => Date.parse("2026-08-31T10:00:00Z"),
  });

  const result = await gateway.loadStandings({ leagueId: LEAGUE_ID, entryId: ENTRY_ID });

  assert.deepEqual(result.league, { id: LEAGUE_ID, name: "Friends League", scoring: "c", closed: false, startEvent: 1 });
  assert.deepEqual(result.connectedManager, {
    entryId: ENTRY_ID,
    rank: 51,
    lastRank: 55,
    rankChange: 4,
    gameweekPoints: 61,
    totalPoints: 99,
    page: 2,
    leagueSize: 80,
  });
  assert.deepEqual(result.standings.rows[0], {
    entryId: ENTRY_ID,
    managerName: "Connected Manager",
    teamName: "Connected XI",
    rank: 51,
    lastRank: 55,
    rankChange: 4,
    gameweekPoints: 61,
    totalPoints: 99,
    pointsGap: 0,
    isConnected: true,
  });
  assert.deepEqual(result.freshness, {
    officialUpdatedAt: "2026-08-31T09:29:18Z",
    fetchedAt: "2026-08-31T10:00:00.000Z",
    stale: false,
    warnings: [],
  });
  assert.equal(result.source, "official-fpl");
  assert.equal(result.seasonOver, false);
  assert.equal(result.partial, false);
  assert.doesNotMatch(JSON.stringify(result), /secret_email|private_note|admin_entry|club_badge_src/);
});

test("explicit pagination keeps the official user row from their own page and computes signed gaps", async () => {
  const fixtures = successfulFixtures([
    standing({ entry: 8, entry_name: "Leader XI", player_name: "Leader", rank: 1, last_rank: 2, event_total: 70, total: 110 }),
    standing({ entry: 9, entry_name: "Chaser XI", player_name: "Chaser", rank: 2, last_rank: 1, event_total: 58, total: 95 }),
  ]);
  const gateway = createMiniLeagueGateway({ fetcher: fixtureFetch(fixtures) });

  const result = await gateway.loadStandings({ leagueId: LEAGUE_ID, entryId: ENTRY_ID, page: 1 });

  assert.equal(result.connectedManager.page, 2);
  assert.equal(result.standings.page, 1);
  assert.deepEqual(result.standings.rows.map(row => row.pointsGap), [11, -4]);
  assert.equal(result.standings.rows.every(row => !row.isConnected), true);
});

test("a tied rank spilling across a page boundary is found by bounded adjacent-page probing", async () => {
  const calls: string[] = [];
  const tiedEntry = entryPayload({
    leagues: { classic: [{ id: LEAGUE_ID, scoring: "c", entry_rank: 50, entry_last_rank: 50, rank_count: 80 }] },
  });
  const fixtures = {
    "/bootstrap-static/": bootstrapPayload(false),
    [`/entry/${ENTRY_ID}/`]: tiedEntry,
    "page_standings=1": standingsPayload(1, [standing({ entry: 8, rank: 50, rank_sort: 50 })]),
    "page_standings=2": standingsPayload(2, [standing({ rank: 50, rank_sort: 51 })]),
    "page_standings=3": standingsPayload(3, []),
  };
  const gateway = createMiniLeagueGateway({ fetcher: fixtureFetch(fixtures, calls) });

  const result = await gateway.loadStandings({ leagueId: LEAGUE_ID, entryId: ENTRY_ID });

  assert.equal(result.connectedManager.page, 2);
  assert.equal(result.standings.page, 2);
  assert.equal(calls.filter(url => url.includes("page_standings=")).length, 2, "only the calculated page and one adjacent page are needed");
});

test("malformed rows on an internally-probed page never taint the displayed page's warning or partial flag", async () => {
  const tiedEntry = entryPayload({
    leagues: { classic: [{ id: LEAGUE_ID, scoring: "c", entry_rank: 50, entry_last_rank: 50, rank_count: 80 }] },
  });
  const fixtures = {
    "/bootstrap-static/": bootstrapPayload(false),
    [`/entry/${ENTRY_ID}/`]: tiedEntry,
    // Calculated page (1) is only ever used to locate the tied user, is never the displayed
    // page, and carries malformed rows that must not leak into the shown result.
    "page_standings=1": standingsPayload(1, [
      { entry: "bad" },
      standing({ entry: 8, rank: 50, rank_sort: 50 }),
    ]),
    // The user is actually found here, cleanly, and this is the page that gets displayed.
    "page_standings=2": standingsPayload(2, [standing({ rank: 50, rank_sort: 51 })]),
    "page_standings=3": standingsPayload(3, []),
  };
  const gateway = createMiniLeagueGateway({ fetcher: fixtureFetch(fixtures) });

  const result = await gateway.loadStandings({ leagueId: LEAGUE_ID, entryId: ENTRY_ID });

  assert.equal(result.standings.page, 2);
  assert.equal(result.standings.rows.length, 1);
  assert.equal(result.partial, false, "the displayed page has no malformed rows of its own");
  assert.doesNotMatch(result.freshness.warnings.join(" "), /malformed/i);
});

test("membership failure and non-classic scoring are rejected with distinct honest errors", async () => {
  const notMember = createMiniLeagueGateway({
    fetcher: fixtureFetch({
      "/bootstrap-static/": bootstrapPayload(false),
      [`/entry/${ENTRY_ID}/`]: entryPayload({ leagues: { classic: [] } }),
    }),
  });
  await assert.rejects(
    () => notMember.loadStandings({ leagueId: LEAGUE_ID, entryId: ENTRY_ID }),
    (error: unknown) => error instanceof MiniLeagueGatewayError && error.status === 409 && /does not belong/i.test(error.message),
  );

  const wrongScoring = createMiniLeagueGateway({
    fetcher: fixtureFetch({
      ...successfulFixtures(),
      "page_standings=2": standingsPayload(2, [standing()], { league: { id: LEAGUE_ID, name: "Head to Head", league_type: "x", scoring: "h", closed: false, start_event: 1 } }),
    }),
  });
  await assert.rejects(
    () => wrongScoring.loadStandings({ leagueId: LEAGUE_ID, entryId: ENTRY_ID }),
    (error: unknown) => error instanceof MiniLeagueGatewayError && error.status === 422 && /classic scoring/i.test(error.message),
  );
});

test("malformed standings rows are omitted and disclosed without discarding valid rows", async () => {
  const gateway = createMiniLeagueGateway({
    fetcher: fixtureFetch(successfulFixtures(undefined, [standing(), { entry: "bad", rank: null, total: "NaN" }])),
  });

  const result = await gateway.loadStandings({ leagueId: LEAGUE_ID, entryId: ENTRY_ID });

  assert.equal(result.standings.rows.length, 1);
  assert.equal(result.partial, true);
  assert.match(result.freshness.warnings[0], /1 malformed standings row/i);
});

test("inaccessible league and malformed upstream payloads retain distinct failure reasons", async () => {
  const inaccessible = createMiniLeagueGateway({
    fetcher: fixtureFetch({
      "/bootstrap-static/": bootstrapPayload(false),
      [`/entry/${ENTRY_ID}/`]: entryPayload(),
      "page_standings=2": new Response(JSON.stringify({ detail: "Not found." }), { status: 404 }),
    }),
  });
  await assert.rejects(
    () => inaccessible.loadStandings({ leagueId: LEAGUE_ID, entryId: ENTRY_ID }),
    (error: unknown) => error instanceof MiniLeagueGatewayError && error.status === 404 && /not found|not publicly accessible/i.test(error.message),
  );

  const malformed = createMiniLeagueGateway({
    fetcher: fixtureFetch({ ...successfulFixtures(), "page_standings=2": { league: null, standings: null } }),
  });
  await assert.rejects(
    () => malformed.loadStandings({ leagueId: LEAGUE_ID, entryId: ENTRY_ID }),
    (error: unknown) => error instanceof MiniLeagueGatewayError && error.status === 502 && /malformed/i.test(error.message),
  );
});

test("an upstream request is aborted at the configured timeout", async () => {
  const fetcher = (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
  const gateway = createMiniLeagueGateway({ fetcher, timeoutMs: 10 });

  await assert.rejects(
    () => gateway.loadStandings({ leagueId: LEAGUE_ID, entryId: ENTRY_ID }),
    (error: unknown) => error instanceof MiniLeagueGatewayError && error.status === 504 && /timed out/i.test(error.message),
  );
});

test("the reusable limiter never runs more than three upstream operations simultaneously", async () => {
  const limiter = createConcurrencyLimiter(3);
  let active = 0;
  let maximum = 0;
  const releases: (() => void)[] = [];
  const tasks = Array.from({ length: 7 }, (_, index) => limiter.run(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => releases.push(resolve));
    active--;
    return index;
  }));

  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(active, 3);
  while (releases.length) {
    releases.shift()!();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(maximum, 3);
});

test("bounded cache enforces TTL, stale window, eviction, and immutable snapshots", () => {
  const cache = new BoundedTtlCache<{ nested: { value: number } }>(2);
  cache.set("a", { nested: { value: 1 } }, 0);
  cache.set("b", { nested: { value: 2 } }, 0);
  assert.equal(cache.get("a", 59, 60, 900)?.state, "fresh");
  assert.equal(cache.get("a", 60, 60, 900)?.state, "stale");
  const snapshot = cache.get("a", 60, 60, 900)!.value;
  assert.throws(() => { snapshot.nested.value = 99; }, TypeError);
  assert.equal(cache.get("a", 60, 60, 900)!.value.nested.value, 1);
  cache.set("c", { nested: { value: 3 } }, 61);
  assert.equal(cache.size, 2);
  assert.equal(cache.get("b", 61, 60, 900), null, "least-recently-used entry is evicted");
  assert.equal(cache.get("a", 901, 60, 900), null, "stale entries expire at the stale-if-error boundary");
});

test("expired data is served only after a refresh failure and is explicitly marked stale", async () => {
  let now = 0;
  let fail = false;
  const base = fixtureFetch(successfulFixtures());
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (fail) throw new Error("upstream down");
    return base(input, init);
  };
  const gateway = createMiniLeagueGateway({ fetcher, now: () => now, standingsTtlMs: 60, metadataTtlMs: 60, staleIfErrorMs: 900 });
  const first = await gateway.loadStandings({ leagueId: LEAGUE_ID, entryId: ENTRY_ID });
  assert.equal(first.freshness.stale, false);

  now = 61;
  fail = true;
  const stale = await gateway.loadStandings({ leagueId: LEAGUE_ID, entryId: ENTRY_ID });
  assert.equal(stale.freshness.stale, true);
  assert.match(stale.freshness.warnings.join(" "), /cached official data/i);

  now = 901;
  await assert.rejects(
    () => gateway.loadStandings({ leagueId: LEAGUE_ID, entryId: ENTRY_ID }),
    (error: unknown) => error instanceof MiniLeagueGatewayError && error.status === 502,
  );
});

test("season-over state comes only from the complete official event list", async () => {
  const gateway = createMiniLeagueGateway({
    fetcher: fixtureFetch({ ...successfulFixtures(), "/bootstrap-static/": bootstrapPayload(true) }),
  });
  const result = await gateway.loadStandings({ leagueId: LEAGUE_ID, entryId: ENTRY_ID });
  assert.equal(result.seasonOver, true);
});
