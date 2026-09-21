import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Transfers UI: confidence label uses full copy", () => {
  const coach = readFileSync(new URL("../app/components/CoachApp.tsx", import.meta.url), "utf8");
  assert.match(coach, /% confidence · \{r\.risk\} risk/);
  assert.doesNotMatch(coach, /% conf ·/);
});

test("Transfers UI: wires authoritative live FT (limit − made) into rankings", () => {
  const coach = readFileSync(new URL("../app/components/CoachApp.tsx", import.meta.url), "utf8");
  assert.match(coach, /resolveAuthoritativeFreeTransfers/);
  assert.match(coach, /authoritativeFreeTransfers/);
  assert.match(coach, /HOLD \/ NO TRANSFER/);
  // Overview must not hardcode FT=1 into bestTransfers anymore
  assert.doesNotMatch(coach, /bestTransfers\(data,squad,finance\.baselineBank,1,/);
});

test("team API exposes freeTransferLimit from live my-team", () => {
  const route = readFileSync(new URL("../app/api/fpl/team/route.ts", import.meta.url), "utf8");
  assert.match(route, /freeTransferLimit:\s*liveFinance \? liveFinance\.freeTransferLimit/);
});
