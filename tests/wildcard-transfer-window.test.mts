import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { managerWildcardActive } from "../app/lib/best-decision.ts";
import {
  chipPlayedForEvent,
  isFreeHitActive,
  isMyTeamChipLiveActive,
  isWildcardActive,
  resolveTransferWindowChip,
  selectOpenTransferEventId,
} from "../app/lib/personal-fpl-transfer/chip-state.ts";
import type { ManagerMeta } from "../app/lib/squad-comparison.ts";

/**
 * Live shape on 2026-10-12: GW6 is in play (deadline 10 Oct passed), GW7 is the
 * open transfer window (deadline 17 Oct). A wildcard confirmed for GW6 stays on
 * that event's picks.active_chip and on history.chips. It is not armed for GW7.
 */
const NOW = Date.parse("2026-10-12T12:00:00Z");
const EVENTS = [
  { id: 5, finished: true, deadlineTime: "2026-09-18T17:30:00Z" },
  { id: 6, finished: false, deadlineTime: "2026-10-10T10:00:00Z" },
  { id: 7, finished: false, deadlineTime: "2026-10-17T10:00:00Z" },
];

const playedWildcard = {
  name: "wildcard",
  number: 1,
  status_for_entry: "played",
  is_pending: false,
  played_by_entry: [6],
  start_event: 2,
  stop_event: 19,
  chip_type: "transfer",
};

const laterWildcard = {
  name: "wildcard",
  number: 1,
  status_for_entry: "unavailable",
  is_pending: false,
  played_by_entry: [] as number[],
  start_event: 20,
  stop_event: 38,
  chip_type: "transfer",
};

function meta(partial: Partial<ManagerMeta>): ManagerMeta {
  return {
    id: 1,
    name: "Manager",
    teamName: "Edge",
    overallPoints: 0,
    overallRank: 0,
    gameweekPoints: 0,
    gameweekRank: 0,
    squadValue: 100,
    bank: 0.5,
    bankSource: "live-my-team",
    transfersMade: 0,
    transferCost: 0,
    freeTransferLimit: 1,
    captainId: 1,
    viceCaptainId: 2,
    chip: null,
    ...partial,
  };
}

test("selectOpenTransferEventId: in-play GW after its deadline is not the transfer window", () => {
  assert.equal(selectOpenTransferEventId(EVENTS, NOW), 7);
  assert.equal(selectOpenTransferEventId(EVENTS, Date.parse("2026-10-09T12:00:00Z")), 6);
});

test("chip history: a wildcard played in a previous GW is not the current GW chip", () => {
  const history = [
    { name: "bboost", event: 1 },
    { name: "wildcard", event: 6 },
  ];
  assert.equal(chipPlayedForEvent(history, 7), null);
  assert.equal(chipPlayedForEvent(history, 6), "wildcard");
});

test("wildcard used in a previous GW does not trigger wildcard mode in the current GW", () => {
  const history = [{ name: "wildcard", event: 6, time: "2026-10-10T09:00:00Z" }];
  const windowChip = resolveTransferWindowChip({
    liveChipsKnown: true,
    liveChips: [playedWildcard, laterWildcard],
    liveActiveChip: null,
    chipHistory: history,
    publicActiveChip: "wildcard",
    publicChipEvent: 6,
    currentEvent: 7,
  });
  assert.equal(windowChip, null);

  // Published picks still name the chip that scored GW6. Transfers must ignore it.
  assert.equal(
    managerWildcardActive(meta({ chip: "wildcard", event: 6, transferWindowChip: windowChip })),
    false,
  );
  assert.equal(
    isWildcardActive({
      activeChip: "wildcard",
      currentEvent: 7,
      chips: [playedWildcard, laterWildcard],
      freeTransferLimit: 1,
      bankSource: "live-my-team",
    }),
    false,
  );
});

test("public fallback: previous GW active_chip and history do not arm the current GW", () => {
  assert.equal(
    resolveTransferWindowChip({
      liveChipsKnown: false,
      chipHistory: [{ name: "wildcard", event: 6 }],
      publicActiveChip: "wildcard",
      publicChipEvent: 6,
      currentEvent: 7,
    }),
    null,
  );
  assert.equal(
    resolveTransferWindowChip({
      liveChipsKnown: false,
      chipHistory: [{ name: "freehit", event: 5 }],
      publicActiveChip: "freehit",
      publicChipEvent: 5,
      currentEvent: 7,
    }),
    null,
  );
});

test("status active with is_pending false is not an armed wildcard", () => {
  assert.equal(
    isMyTeamChipLiveActive(
      { name: "wildcard", status_for_entry: "active", is_pending: false, played_by_entry: [6] },
      7,
    ),
    false,
  );
  assert.equal(
    isMyTeamChipLiveActive({ name: "wildcard", status_for_entry: "active", played_by_entry: [6] }, 7),
    false,
  );
  // Legacy payload with no pending flag and no play list still counts as armed.
  assert.equal(isMyTeamChipLiveActive({ name: "wildcard", status_for_entry: "active" }), true);
});

test("wildcard armed for the current GW still enables wildcard mode", () => {
  const pending = {
    name: "wildcard",
    status_for_entry: "available",
    is_pending: true,
    played_by_entry: [] as number[],
    start_event: 2,
    stop_event: 19,
  };
  const windowChip = resolveTransferWindowChip({
    liveChipsKnown: true,
    liveChips: [pending, laterWildcard],
    chipHistory: [{ name: "bboost", event: 1 }],
    publicActiveChip: null,
    publicChipEvent: 6,
    currentEvent: 7,
  });
  assert.equal(windowChip, "wildcard");
  assert.equal(
    managerWildcardActive(meta({ chip: null, event: 6, transferWindowChip: windowChip })),
    true,
  );

  // Confirmed on public history for the open GW before picks exist (no live overlay).
  assert.equal(
    resolveTransferWindowChip({
      liveChipsKnown: false,
      chipHistory: [{ name: "wildcard", event: 7 }],
      publicActiveChip: "wildcard",
      publicChipEvent: 6,
      currentEvent: 7,
    }),
    "wildcard",
  );
});

test("legacy cache without transferWindowChip does not keep a previous GW wildcard active", () => {
  assert.equal(managerWildcardActive(meta({ chip: "wildcard", event: 6 })), false);
  assert.equal(managerWildcardActive(null), false);
});

test("free hit played in a previous GW is not active for the current GW", () => {
  assert.equal(
    isFreeHitActive({
      activeChip: "freehit",
      currentEvent: 7,
      chips: [{ name: "freehit", status_for_entry: "played", is_pending: false, played_by_entry: [5] }],
    }),
    false,
  );
});

test("team API and Transfers read the open-window chip, not the published-event chip", () => {
  const route = readFileSync(new URL("../app/api/fpl/team/route.ts", import.meta.url), "utf8");
  assert.match(route, /resolveTransferWindowChip/);
  assert.match(route, /selectOpenTransferEventId/);
  assert.match(route, /chipHistory/);
  assert.match(route, /entry\/\$\{entry\}\/history\//);
  assert.match(route, /transferWindowChip:/);
  const decision = readFileSync(new URL("../app/lib/best-decision.ts", import.meta.url), "utf8");
  assert.match(decision, /transferWindowChip/);
  assert.doesNotMatch(decision, /activeChip:\s*meta\?\.chip/);
});
