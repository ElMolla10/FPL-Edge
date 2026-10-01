import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildFplMoveLink, DEMO_COPY_PREFIX, FPL_TRANSFERS_URL } from "../app/lib/execute-summary.ts";
import { WEEKLY_DECISION_SOURCE, type WeeklyDecision } from "../app/lib/weekly-decision.ts";

const base = { gameweek: 7, classification: "MAKE", captainId: 1, net3gw: 4, riskAdjustedNet5gw: 8, immediateNet: 2, confidence: 0.8, risk: "Low", why: "x", source: WEEKLY_DECISION_SOURCE, freeTransfers: 1, freeTransferSource: "assumed", wildcardActive: false } as const;
const make = { ...base, action: "MAKE", outPlayerId: 3, inPlayerId: 99, outName: "Raya", inName: "Kelleher", hitCost: 0, net5gw: 8.1, bank: 1.5, row: { bankAfter: 2.0, out: { name: "Raya" }, incoming: { name: "Kelleher", price: 4.5 } } } as unknown as WeeklyDecision;
const hold = { ...base, action: "HOLD", classification: "HOLD", outPlayerId: null, inPlayerId: null, outName: null, inName: null, hitCost: 0, net5gw: 0, bank: 1.5, row: null } as unknown as WeeklyDecision;

test("MAKE renders 'Make this on FPL' with the same OUT/IN as Transfers", () => {
  const l = buildFplMoveLink(make, "Salah", false);
  assert.equal(l.label, "Make this on FPL");
  assert.equal(l.move?.out, make.row!.out.name);
  assert.equal(l.move?.in, make.row!.incoming.name);
  assert.equal(l.move?.bankAfter, 2.0);
  assert.equal(l.move?.hit, "Free");
  const transfers = readFileSync("app/components/coach/TransfersPanel.tsx", "utf8");
  assert.match(transfers, /<FplMoveLink decision=\{wd\}/);
});
test("HOLD does not say 'Make this transfer'", () => {
  const l = buildFplMoveLink(hold, "Salah", false);
  assert.equal(l.label, "Open FPL");
  assert.equal(l.move, null);
  assert.ok(!JSON.stringify(l).toLowerCase().includes("make this transfer"));
});
test("href is exactly the official transfers page with no params", () => {
  assert.equal(FPL_TRANSFERS_URL, "https://fantasy.premierleague.com/transfers");
  assert.equal(buildFplMoveLink(make, null, false).href, "https://fantasy.premierleague.com/transfers");
  const ui = readFileSync("app/components/FplMoveLink.tsx", "utf8");
  assert.match(ui, /target="_blank" rel="noopener noreferrer"/);
  assert.ok(!ui.includes("personal-fpl-transfer") && !ui.includes("<iframe"));
});
test("copy text matches the on-screen move; demo is prefixed", () => {
  const l = buildFplMoveLink(make, "Salah", false);
  assert.equal(l.copyText, `GW7: sell ${l.move!.out}, buy ${l.move!.in}. Then set captain Salah on Pick Team.`);
  assert.ok(buildFplMoveLink(make, "Salah", true).copyText.startsWith(DEMO_COPY_PREFIX));
});
test("Home shows the FPL link only on MAKE", () => {
  assert.match(readFileSync("app/components/CoachApp.tsx", "utf8"), /wd\?\.action==="MAKE"&&<FplMoveLink/);
});
