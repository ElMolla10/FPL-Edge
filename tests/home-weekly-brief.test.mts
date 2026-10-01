import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const home = readFileSync(new URL("../app/components/CoachApp.tsx", import.meta.url), "utf8");
const transfers = readFileSync(new URL("../app/components/coach/TransfersPanel.tsx", import.meta.url), "utf8");
const start = home.indexOf('<section className="weekly-brief"');
const end = home.indexOf('<section className="urgent-card">', start);
const brief = home.slice(start, end);

test("Home brief renders canonical action, captain and projected GW", () => {
  assert.ok(start > 0 && end > start);
  assert.match(brief, /wd\.outName\} → \$\{wd\.inName\}/);
  assert.match(brief, /HOLD — no transfer this week/);
  assert.match(brief, /CAPTAIN/);
  assert.match(brief, /PROJECTED GW/);
  assert.match(brief, /OverviewDeadlineStrip/);
  assert.match(brief, /shortReason/);
});
test("primary CTA always opens the weekly close (Final Check), labelled by the call", () => {
  assert.match(home, /const primaryCta=\{label:decisionHold\?"Close the week: Final Check →":"Execute this move: Final Check →",view:"deadline"/);
});
test("no scenario / percentile / NET-table copy in the first Home section", () => {
  for (const s of ["P10", "P50", "P90", "1,024", "scenario", "type-B", "5-GW NET", "price pressure"]) {
    assert.ok(!brief.toLowerCase().includes(s.toLowerCase()), `brief contains ${s}`);
  }
});
test("urgent: at most 3, XI + first bench only", () => {
  assert.match(home, /classifyUrgency\(/);
  assert.match(home, /risk\.urgent\.slice\(0,3\)/);
});
test("Transfers still has the full breakdown", () => {
  assert.match(transfers, /formatNet/);
  assert.match(transfers, /useWeeklyDecision/);
});
