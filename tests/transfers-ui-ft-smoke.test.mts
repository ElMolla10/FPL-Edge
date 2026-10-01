import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readCoachSource } from "./helpers/coach-source.mts";

test("Transfers UI: confidence label uses full copy", () => {
  const coach = readCoachSource();
  // r7+: evidence strength labelled "projection evidence" (not abbreviated "conf")
  assert.match(coach, /% projection evidence · \{r\.risk\} risk/);
  assert.doesNotMatch(coach, /% conf ·/);
});

test("Transfers UI: wires authoritative live FT (limit − made) into rankings", () => {
  const coach = readCoachSource();
  assert.match(coach, /resolveAuthoritativeFreeTransfers/);
  assert.match(coach, /authoritativeFreeTransfers/);
  assert.match(coach, /HOLD[\s\S]*NO TRANSFER/);
  // Must import client-safe ft-state — barrel pulls store → db → cloudflare:workers into Vite client.
  assert.match(coach, /from ["'](?:(?:\.\.\/)+lib\/|\.\/)personal-fpl-transfer\/ft-state["']/);
  assert.doesNotMatch(coach, /from ["'](?:(?:\.\.\/)+lib\/|\.\/)personal-fpl-transfer["']/);
  // Overview must not hardcode FT=1 into bestTransfers anymore
  assert.doesNotMatch(coach, /bestTransfers\(data,squad,finance\.baselineBank,1,/);
});

test("team API exposes freeTransferLimit from live my-team", () => {
  const route = readTeamApiSource();
  assert.match(route, /freeTransferLimit:\s*liveFinance \? liveFinance\.freeTransferLimit/);
});

test("Transfers UI: PriceIntel skips HOLD and priceOutlookSignal defaults missing arrays", () => {
  const coach = readCoachSource();
  assert.match(coach, /priceOutlookDays/);
  assert.match(coach, /Array\.isArray\(raw\)\?raw:\[\]/);
  assert.match(coach, /!r\.isHold&&r\.classification!=="HOLD"/);
  assert.match(coach, /if\(!player\)return\[\]/);
  assert.match(coach, /if\(!player\)return\{direction:"stable"/);
});

test("Transfers UI: Wildcard Optimization mode switch (not Free transfer labels)", () => {
  const coach = readCoachSource();
  assert.match(coach, /isWildcardActive/);
  assert.match(coach, /managerWildcardActive/);
  assert.match(coach, /wildcardActive/);
  assert.match(coach, /Wildcard Optimization/);
  assert.match(coach, /wildcardMode=\{wildcardActive\}/);
  assert.match(coach, /WILDCARD SWAP CANDIDATES/);
  // Must not show FT selector while Wildcard is active
  assert.match(coach, /fullDesk&&!wildcardActive&&<label>Free transfers/);
  // Chip-state import is client-safe (not the personal-fpl barrel)
  assert.match(coach, /from ["'](?:(?:\.\.\/)+lib\/|\.\/)personal-fpl-transfer\/chip-state["']/);
});

// The /api/fpl/team handler body was extracted verbatim into app/lib/team-response.ts (shared with the email-alert
// cron). These source-contract scans keep guarding the same behaviour across both files.
function readTeamApiSource(): string {
  return readFileSync(new URL("../app/api/fpl/team/route.ts", import.meta.url), "utf8")
    + "\n" + readFileSync(new URL("../app/lib/team-response.ts", import.meta.url), "utf8");
}

test("team API prefers live my-team activeChip for pending Wildcard", () => {
  const route = readTeamApiSource();
  assert.match(route, /liveFinance\?\.activeChip/);
});

test("team API resolves chip via resolveManagerActiveChip (live is_pending + public active_chip)", () => {
  const route = readTeamApiSource();
  assert.match(route, /resolveManagerActiveChip/);
  assert.match(route, /liveActiveChip/);
  assert.match(route, /publicActiveChip/);
  const chip = readFileSync(new URL("../app/lib/personal-fpl-transfer/chip-state.ts", import.meta.url), "utf8");
  assert.match(chip, /is_pending/);
  assert.match(chip, /isMyTeamChipLiveActive/);
  // Activation is on official FPL — Edge only detects
  assert.match(chip, /Activation is on fantasy\.premierleague\.com/);
});

test("team API still gates live overlay behind evaluatePersonalAuthManageGate (#80)", () => {
  const route = readTeamApiSource();
  assert.match(route, /evaluatePersonalAuthManageGate/);
  assert.match(route, /manageGate\.ok && manageGate\.entryId === entry/);
  // Must not call tryFetchLiveTeamFinance for arbitrary public callers
  assert.match(route, /tryFetchLiveTeamFinance\(entry, env\)/);
});
