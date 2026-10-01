import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MiniLeagueWarRoomView } from "../app/components/MiniLeagueWarRoom.tsx";
import { computeLeagueLever } from "../app/lib/league-lever.ts";
import { createRivalPicksRoute } from "../app/api/fpl/league/rivals/route.ts";
import { MiniLeagueGatewayError, RIVAL_PICKS_CAP } from "../app/lib/mini-league-server.ts";

const noop = () => {};
const view = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(MiniLeagueWarRoomView, { connectedEntryId: 7, leagueId: "", onLeagueIdChange: noop, onImport: noop, onPage: noop, onGoToTeam: noop, state: { status: "idle" }, ...props } as never));
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };

test("missing league id → connect/explain empty state", () => {
  store.clear();
  assert.match(view({ connectedEntryId: null }), /Connect your FPL team first/);
  const idle = view({});
  assert.match(idle, /League ID/);
  assert.doesNotMatch(idle, /THIS WEEK IN/);
});
test("demo does not pretend to be in a real league", () => {
  store.set("fpl-edge-example-squad", "1");
  const html = view({ connectedEntryId: 7 });
  assert.match(html, /Demo isn(&#x27;|')t in a league/);
  assert.doesNotMatch(html, /Import league|THIS WEEK IN/);
  store.clear();
});
test("endpoint failure returns a clear error, never a crash", async () => {
  const route = createRivalPicksRoute({ loadRivalPicks: async () => { throw new MiniLeagueGatewayError(502, "Official FPL did not share any rival picks for this league right now.", "picks-unavailable", true); } });
  const res = await route(new Request("http://x/api/fpl/league/rivals?league=1&entry=2"));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /rival picks/);
  const boom = createRivalPicksRoute({ loadRivalPicks: async () => { throw new TypeError("x"); } });
  assert.equal((await boom(new Request("http://x/?league=1&entry=2"))).status, 500);
  assert.equal(RIVAL_PICKS_CAP, 20);
});
test("lever is league-local: your differential vs the rivals' template", () => {
  const xi = Array.from({ length: 11 }, (_, i) => i + 1);
  const rivalXi = [...Array.from({ length: 10 }, (_, i) => i + 1), 99];
  const rivals = [1, 2, 3, 4].map(entryId => ({ entryId, picks: [...rivalXi, 12, 13, 14, 15].map((element, i) => ({ element, position: i + 1, multiplier: 1, isCaptain: element === 1 })) }));
  const r = computeLeagueLever({ xiIds: xi, benchIds: [12, 13, 14, 15], captainId: 1, rivals, projection: id => (id === 11 ? 8 : id === 99 ? 3 : 4) });
  assert.deepEqual(r.lever && [r.lever.playerId, r.lever.kind, r.lever.rivalOwnPct], [11, "yours", 0]);
  assert.deepEqual(r.captains, [{ playerId: 1, pct: 100 }]);
  assert.ok(r.userProjection > r.leagueAverageProjection);
  const rivals11 = rivals.map(x => ({ ...x, picks: x.picks.map(p => (p.element === 99 ? { ...p, element: 11 } : p)) }));
  const threat = computeLeagueLever({ xiIds: [...xi.slice(0, 10), 50], benchIds: [12, 13, 14, 15], captainId: 1, rivals: rivals11, projection: id => (id === 11 ? 9 : id === 50 ? 1 : 4) });
  assert.deepEqual(threat.lever && [threat.lever.playerId, threat.lever.kind, threat.lever.rivalOwnPct], [11, "threat", 100]);
});
