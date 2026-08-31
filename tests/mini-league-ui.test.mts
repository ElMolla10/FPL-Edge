import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CoachApp from "../app/components/CoachApp.tsx";
import { MiniLeagueWarRoomView } from "../app/components/MiniLeagueWarRoom.tsx";
import {
  createMiniLeagueRequestManager,
  parseLeagueIdInput,
} from "../app/lib/mini-league-client.ts";
import type { MiniLeagueStandingsResult, MiniLeagueUiState } from "../app/lib/mini-league.ts";

const availableResult: MiniLeagueStandingsResult = {
  source: "official-fpl",
  seasonOver: false,
  partial: false,
  league: { id: 123, name: "Friends League", scoring: "c", closed: false, startEvent: 1 },
  connectedManager: { entryId: 7, rank: 2, lastRank: 6, rankChange: 4, gameweekPoints: 61, totalPoints: 100, page: 1, leagueSize: 3 },
  standings: {
    page: 1,
    hasNext: true,
    rows: [
      { entryId: 8, managerName: "Leader Name", teamName: "Leader XI", rank: 1, lastRank: 1, rankChange: 0, gameweekPoints: 70, totalPoints: 111, pointsGap: 11, isConnected: false },
      { entryId: 7, managerName: "Connected Name", teamName: "Connected XI", rank: 2, lastRank: 6, rankChange: 4, gameweekPoints: 61, totalPoints: 100, pointsGap: 0, isConnected: true },
      { entryId: 9, managerName: "Chaser Name", teamName: "Chaser XI", rank: 3, lastRank: 2, rankChange: -1, gameweekPoints: 55, totalPoints: 96, pointsGap: -4, isConnected: false },
    ],
  },
  freshness: { officialUpdatedAt: "2026-08-31T09:29:18Z", fetchedAt: "2026-08-31T09:30:00Z", stale: false, warnings: [] },
};

function render(state: MiniLeagueUiState, entryId: number | null = 7) {
  return renderToStaticMarkup(createElement(MiniLeagueWarRoomView, {
    connectedEntryId: entryId,
    leagueId: "123",
    onLeagueIdChange: () => {},
    onImport: () => {},
    onPage: () => {},
    onGoToTeam: () => {},
    state,
  }));
}

test("Coach navigation exposes a Mini-League destination", () => {
  const html = renderToStaticMarkup(createElement(CoachApp, { onBack: () => {} }));
  assert.match(html, />Mini-League</);
});

test("without a connected team the War Room routes to the existing Team connection flow", () => {
  const html = render({ status: "idle" }, null);
  assert.match(html, /Connect your FPL team first/);
  assert.match(html, />Go to My team →</);
  assert.doesNotMatch(html, /League ID/);
});

test("idle and loading states expose one League ID input and accessible progress", () => {
  const idle = render({ status: "idle" });
  assert.match(idle, /<label[^>]*>League ID</);
  assert.equal((idle.match(/<input/g) ?? []).length, 1, "there must not be a second manager-ID input");
  assert.doesNotMatch(idle, /Team ID/);
  const loading = render({ status: "loading", leagueId: 123 });
  assert.match(loading, /aria-live="polite"/);
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /Loading official league standings/);
});

test("available standings render official summary, rank movement, signed gaps, user highlight and pagination", () => {
  const html = render({ status: "available", result: availableResult });
  assert.match(html, /Friends League/);
  assert.match(html, /Rank 2/);
  assert.match(html, /↑ 4 places/);
  assert.match(html, /61/);
  assert.match(html, /100/);
  assert.match(html, /Leader Name/);
  assert.match(html, /Leader XI/);
  assert.match(html, /\+11/);
  assert.match(html, /−4/);
  assert.match(html, /class="mini-league-user-row"[^>]*aria-current="true"/);
  assert.match(html, /Official FPL standings/);
  assert.match(html, /Previous/);
  assert.match(html, /Next/);
  assert.match(html, /Page 1/);
});

test("empty, stale, partial and season-over states are explicit", () => {
  const empty = render({ status: "available", result: { ...availableResult, standings: { page: 2, hasNext: false, rows: [] } } });
  assert.match(empty, /No standings rows are available on this page/);

  const stale = render({ status: "available", result: {
    ...availableResult,
    partial: true,
    seasonOver: true,
    freshness: { ...availableResult.freshness, stale: true, warnings: ["Showing cached official data because FPL could not refresh it.", "1 malformed standings row was omitted."] },
  } });
  assert.match(stale, /Cached official standings/);
  assert.match(stale, /Season complete/);
  assert.match(stale, /1 malformed standings row was omitted/);
  assert.match(stale, /aria-live="polite"/);
});

test("invalid, membership, unsupported, inaccessible, timeout, upstream, and unexpected failures retain their real reason", () => {
  const cases: { kind: Extract<MiniLeagueUiState, { status: "error" }>["kind"]; reason: string; heading: RegExp }[] = [
    { kind: "invalid", reason: "League ID must be a positive integer.", heading: /Check the league ID/ },
    { kind: "membership", reason: "Your connected team is not in this league.", heading: /Membership not found/ },
    { kind: "unsupported", reason: "This War Room supports classic scoring leagues only.", heading: /Unsupported league/ },
    { kind: "inaccessible", reason: "League not found or inaccessible.", heading: /League unavailable/ },
    { kind: "timeout", reason: "Official FPL timed out.", heading: /Request timed out/ },
    { kind: "upstream", reason: "Official FPL is unavailable.", heading: /Official data unavailable/ },
    { kind: "unexpected", reason: "Unexpected response.", heading: /Unexpected failure/ },
  ];
  for (const item of cases) {
    const html = render({ status: "error", kind: item.kind, reason: item.reason });
    assert.match(html, item.heading);
    assert.match(html, new RegExp(item.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(html, /aria-live="assertive"/);
  }
});

test("client League ID validation rejects non-positive and non-integer input without coercion", () => {
  assert.equal(parseLeagueIdInput("123"), 123);
  for (const value of ["", "0", "-1", "+1", "1.5", "abc"]) assert.equal(parseLeagueIdInput(value), null);
});

test("a newer request aborts its predecessor and a late stale response cannot overwrite current state", async () => {
  const requests: { url: string; signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  const fetcher = (input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(resolve => {
    requests.push({ url: String(input), signal: init!.signal!, resolve });
  });
  const states: MiniLeagueUiState[] = [];
  const manager = createMiniLeagueRequestManager(fetcher);
  const first = manager.load({ leagueId: 123, entryId: 7 }, state => states.push(state));
  const second = manager.load({ leagueId: 456, entryId: 7 }, state => states.push(state));
  assert.equal(requests[0].signal.aborted, true);
  assert.match(requests[1].url, /league=456/);

  const secondResult = { ...availableResult, league: { ...availableResult.league, id: 456, name: "New League" } };
  requests[1].resolve(Response.json(secondResult));
  await second;
  requests[0].resolve(Response.json(availableResult));
  await first;

  const final = states.at(-1);
  assert.equal(final?.status, "available");
  if (final?.status === "available") assert.equal(final.result.league.id, 456);
});

test("explicit cancellation aborts the active request and suppresses its eventual completion", async () => {
  let signal: AbortSignal | undefined;
  let resolve!: (response: Response) => void;
  const states: MiniLeagueUiState[] = [];
  const manager = createMiniLeagueRequestManager((_input, init) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(done => { resolve = done; });
  });
  const pending = manager.load({ leagueId: 123, entryId: 7 }, state => states.push(state));
  manager.cancel();
  assert.equal(signal?.aborted, true);
  resolve(Response.json(availableResult));
  await pending;
  assert.equal(states.at(-1)?.status, "loading", "cancelled response must not publish a result");
});

test("client maps server failures into honest UI categories", async () => {
  const fixtures = [
    [400, "invalid-league", "invalid"],
    [409, "not-a-member", "membership"],
    [422, "unsupported-scoring", "unsupported"],
    [404, "league-inaccessible", "inaccessible"],
    [504, "fpl-timeout", "timeout"],
    [502, "fpl-upstream", "upstream"],
    [500, "unexpected", "unexpected"],
  ] as const;
  for (const [status, code, kind] of fixtures) {
    let final: MiniLeagueUiState = { status: "idle" };
    const manager = createMiniLeagueRequestManager(async () => Response.json({ error: `failure-${code}`, code }, { status }));
    await manager.load({ leagueId: 123, entryId: 7 }, state => { final = state; });
    assert.deepEqual(final, { status: "error", kind, reason: `failure-${code}` });
  }
});

test("Mini-League state reuses the connected entry but never persists league or standings data", () => {
  const component = readFileSync(new URL("../app/components/MiniLeagueWarRoom.tsx", import.meta.url), "utf8");
  const hook = readFileSync(new URL("../app/components/useMiniLeagueWarRoom.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../app/lib/mini-league-client.ts", import.meta.url), "utf8");
  assert.match(component, /localStorage\.getItem\("fpl-edge-entry"\)/);
  assert.doesNotMatch(`${component}\n${hook}\n${client}`, /(?:localStorage|sessionStorage)\.(?:setItem|removeItem)/);
});
