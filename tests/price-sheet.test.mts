import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildPriceSheet } from "../app/lib/price-sheet.ts";
import type { FplPlayer } from "../app/lib/fpl.ts";

const pl = (id: number, today = 0, tomorrow = 0) => ({
  id, name: `P${id}`, price: 5, priceProjectionToday: today,
  priceOutlook: [{ offsetDays: 0, projectedPercent: today, likelihood: Math.sign(today) }, { offsetDays: 1, projectedPercent: tomorrow, likelihood: Math.sign(tomorrow) }, { offsetDays: 2, projectedPercent: 0, likelihood: 0 }],
} as unknown as FplPlayer);
const squad = Array.from({ length: 15 }, (_, i) => pl(i + 1));

test("unowned random players never appear, even with big pressure", () => {
  const market = [...squad, pl(900, -90), pl(901, 95)];
  const s = buildPriceSheet({ squad, players: market });
  assert.equal(s.rows.length, 0);
  assert.equal(s.teaser, null);
});
test("owned fall pressure and canonical IN/OUT are the only rows, with three day labels", () => {
  const sq = squad.map(p => (p.id === 3 ? pl(3, -62) : p.id === 5 ? pl(5, 0, -20) : p));
  const s = buildPriceSheet({ squad: sq, players: [...sq, pl(500, 70), pl(600, -99)], outPlayerId: 7, inPlayerId: 500 });
  assert.deepEqual(s.rows.map(r => [r.player.id, r.role]), [[500, "in"], [7, "out"], [3, "owned"], [5, "owned"]]);
  assert.deepEqual(s.rows[0].days.map(d => d.label), ["Today", "Tomorrow", "Day after"]);
  assert.match(s.teaser ?? "", /P3 could drop tonight · P500 could rise/);
});
test("demo uses example XV only: sheet built from savedSquad, not the market", () => {
  const src = readFileSync("app/components/coach/PriceSheetPanel.tsx", "utf8");
  assert.match(src, /savedSquad\(data\)/);
  assert.doesNotMatch(src, /data\.players\.(filter|sort|slice)/);
  const sheet = buildPriceSheet({ squad: [pl(1, -40)], players: [pl(1, -40), pl(2, -80)] });
  assert.deepEqual(sheet.rows.map(r => r.player.id), [1]);
});
test("Home shows only a one-line teaser + link, never the sheet", () => {
  const src = readFileSync("app/components/CoachApp.tsx", "utf8");
  const overview = src.slice(src.indexOf("function Overview("));
  assert.match(overview, /overview-price-teaser/);
  assert.match(overview, /go\("prices"\)/);
  assert.doesNotMatch(overview, /<PriceSheet\b|price-sheet-row/);
});
