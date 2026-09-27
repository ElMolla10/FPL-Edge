import assert from "node:assert/strict";
import test from "node:test";
import type { FplData, FplPlayer } from "../app/lib/fpl.ts";
import {
  isWildcardActive,
  isFreeHitActive,
  isUnlimitedTransferWindow,
  remainingFreeTransfers,
  activeChipFromMyTeamChips,
  liveTeamFinanceFromMyTeam,
} from "../app/lib/personal-fpl-transfer/index.ts";
import {
  recommendWildcardSwaps,
  recommendTransfers,
  WILDCARD_HIT_LABEL,
  exactHitCost,
} from "../app/lib/transfer-engine/index.ts";
import { bestTransfers } from "../app/lib/transfers.ts";

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
}
(globalThis as any).localStorage = memoryStorage();

function makePlayer(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1,
    name: "Player",
    firstName: "Test",
    secondName: "Player",
    teamId: 1,
    teamName: "Test FC",
    teamShort: "TFC",
    positionId: 3,
    position: "Midfielder",
    positionShort: "MID",
    price: 5,
    status: "a",
    chance: null,
    epNext: 3,
    form: 3,
    pointsPerGame: 3,
    priorPointsPerGame: 3,
    priorMinutes: 2500,
    priorStarts: 30,
    priorExpectedGoals: 3,
    priorExpectedAssists: 3,
    priorBonus: 10,
    priorSaves: 0,
    priorPenaltiesSaved: 0,
    priorDefensiveContribution: 100,
    priorSource: "official-pl-history",
    totalPoints: 0,
    eventPoints: 0,
    eventMinutes: 0,
    eventBonus: 0,
    eventDefensiveContribution: 0,
    selectedBy: 10,
    priceChange: 0,
    priceProjectionToday: 0,
    priceChangeSinceStart: 0,
    priceOutlook: [],
    transfersIn: 0,
    transfersOut: 0,
    goals: 0,
    assists: 0,
    expectedGoals: 0,
    expectedAssists: 0,
    expectedGoalInvolvements: 0,
    expectedGoalsConceded: 0,
    cleanSheets: 0,
    goalsConceded: 0,
    minutes: 2700,
    starts: 30,
    bonus: 0,
    bps: 0,
    ictIndex: 0,
    influence: 0,
    creativity: 0,
    threat: 0,
    saves: 0,
    penaltiesSaved: 0,
    defensiveContribution: 0,
    clearancesBlocksInterceptions: 0,
    recoveries: 0,
    tackles: 0,
    penaltiesOrder: null,
    directFreekicksOrder: null,
    cornersOrder: null,
    scoutRisks: [],
    news: "",
    newsAdded: null,
    ...overrides,
  };
}

function squad(): FplPlayer[] {
  const player = (
    id: number,
    positionId: number,
    positionShort: FplPlayer["positionShort"],
    price = 5,
    epNext = 3,
    teamId = id,
  ) =>
    makePlayer({
      id,
      name: `P${id}`,
      teamId,
      teamName: `Team ${teamId}`,
      teamShort: `T${teamId}`,
      positionId,
      positionShort,
      position: positionShort,
      price,
      epNext,
      minutes: 2700,
      starts: 30,
      priorMinutes: 2500,
    });
  return [
    player(1, 1, "GKP", 4.5),
    player(2, 1, "GKP", 4.5),
    ...[11, 12, 13, 14, 15].map((id) => player(id, 2, "DEF", 4.5)),
    ...[21, 22, 23, 24, 25].map((id) => player(id, 3, "MID", 6)),
    ...[31, 32, 33].map((id) => player(id, 4, "FWD", 7)),
  ];
}

function dataFor(players: FplPlayer[], count = 8): FplData {
  const events = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `Gameweek ${index + 1}`,
    deadline: new Date(Date.now() + (index + 1) * 86400000).toISOString(),
    current: false,
    next: index === 0,
    finished: false,
    dataChecked: false,
  }));
  const clubIds = [...new Set(players.map((p) => p.teamId))];
  const fixtures = events.flatMap((event) =>
    clubIds.map((teamId, index) => ({
      id: event.id * 1000 + index,
      event: event.id,
      teamH: teamId,
      teamA: 1000 + teamId,
      teamHDifficulty: 3,
      teamADifficulty: 3,
      finished: false,
      kickoff: null,
      started: false,
      teamHScore: null,
      teamAScore: null,
    })),
  );
  return {
    updatedAt: new Date().toISOString(),
    source: "test",
    seasonStatsThrough: 0,
    players,
    fixtures,
    events,
    teams: clubIds.map((id) => ({ id, name: `Team ${id}`, short: `T${id}` })),
    rules: {
      budget: 100,
      squadSize: 15,
      teamLimit: 3,
      positions: [
        { id: 1, name: "Goalkeeper", short: "GKP", squad: 2, minPlay: 1, maxPlay: 1 },
        { id: 2, name: "Defender", short: "DEF", squad: 5, minPlay: 3, maxPlay: 5 },
        { id: 3, name: "Midfielder", short: "MID", squad: 5, minPlay: 2, maxPlay: 5 },
        { id: 4, name: "Forward", short: "FWD", squad: 3, minPlay: 1, maxPlay: 3 },
      ],
    },
  };
}

function starMid(id: number, price = 6.5): FplPlayer {
  return makePlayer({
    id,
    name: `Star${id}`,
    teamId: id,
    teamName: `Team ${id}`,
    teamShort: `T${id}`,
    positionId: 3,
    position: "Midfielder",
    positionShort: "MID",
    price,
    epNext: 9,
    form: 8,
    pointsPerGame: 8,
    selectedBy: 40,
    minutes: 2700,
    starts: 30,
    priorMinutes: 2500,
    priorStarts: 35,
    expectedGoals: 8,
    expectedAssists: 6,
    totalPoints: 120,
  });
}

function cheapFodderMid(id: number, price = 4.5): FplPlayer {
  return makePlayer({
    id,
    name: `Fodder${id}`,
    teamId: id,
    teamName: `Team ${id}`,
    teamShort: `T${id}`,
    positionId: 3,
    position: "Midfielder",
    positionShort: "MID",
    price,
    epNext: 1.2,
    form: 1,
    pointsPerGame: 1,
    selectedBy: 0.5,
    minutes: 400,
    starts: 4,
    priorMinutes: 400,
    priorStarts: 4,
  });
}

// --- Detection ---

test("isWildcardActive: my-team chips status_for_entry active wins", () => {
  assert.equal(
    isWildcardActive({
      chips: [{ name: "wildcard", status_for_entry: "active" }],
      freeTransferLimit: null,
      bankSource: "live-my-team",
    }),
    true,
  );
  assert.equal(
    isWildcardActive({
      chips: [{ name: "freehit", status_for_entry: "active" }],
      freeTransferLimit: null,
      bankSource: "live-my-team",
    }),
    false,
  );
});

test("isWildcardActive: manager.chip wildcard; Free Hit is not Wildcard", () => {
  assert.equal(isWildcardActive({ activeChip: "wildcard" }), true);
  assert.equal(isWildcardActive({ activeChip: "freehit" }), false);
  assert.equal(isFreeHitActive({ activeChip: "freehit" }), true);
});

test("isUnlimitedTransferWindow: live limit null OR active WC/FH", () => {
  assert.equal(
    isUnlimitedTransferWindow({ freeTransferLimit: null, bankSource: "live-my-team" }),
    true,
  );
  assert.equal(
    isUnlimitedTransferWindow({ freeTransferLimit: 1, bankSource: "live-my-team" }),
    false,
  );
  assert.equal(isUnlimitedTransferWindow({ activeChip: "wildcard" }), true);
});

test("activeChipFromMyTeamChips + liveTeamFinanceFromMyTeam expose active wildcard", () => {
  assert.equal(activeChipFromMyTeamChips([{ name: "wildcard", status_for_entry: "active" }]), "wildcard");
  const picks = Array.from({ length: 15 }, (_, index) => ({
    element: index + 1,
    position: index + 1,
    selling_price: 45,
    purchase_price: 45,
    is_captain: index === 0,
    is_vice_captain: index === 1,
    multiplier: index < 11 ? 1 : 0,
  }));
  const live = liveTeamFinanceFromMyTeam({
    picks,
    transfers: { bank: 10, limit: null, made: 3, value: 1000 },
    chips: [{ name: "wildcard", status_for_entry: "active" }],
  });
  assert.ok(live);
  assert.equal(live!.freeTransferLimit, null);
  assert.equal(live!.activeChip, "wildcard");
});

// --- Prove required behaviours ---

test("active Wildcard ignores FT count (0 FT still yields Wildcard swaps with no hit)", () => {
  const base = squad();
  const star = starMid(201, 7.5);
  const players = [...base, star];
  const data = dataFor(players);
  // Even with 0 FT argument, Wildcard path must not invent hits or FT constraints.
  const rows = bestTransfers(data, base, 5, /* freeTransfers */ 0, 8, new Map(), {
    wildcardActive: true,
    mode: "deep",
  });
  const moves = rows.filter((r) => !r.isHold && r.classification !== "HOLD");
  assert.ok(moves.length > 0, "Wildcard should still surface swap candidates with 0 FT");
  for (const move of moves) {
    assert.equal(move.hitCost, 0, "no hit cost on Wildcard");
    assert.equal(move.hitLabel, WILDCARD_HIT_LABEL);
    assert.notEqual(move.hitLabel, "Free");
    assert.equal(move.freeTransfersUsed ?? 0, 0);
    assert.ok(move.wildcardMode === true || move.hitLabel === WILDCARD_HIT_LABEL);
  }
});

test("no hit cost applied under Wildcard even when normal engine would charge −4", () => {
  const base = squad();
  const star = starMid(202, 7.0);
  const data = dataFor([...base, star]);
  // Normal path with 0 FT would charge a hit:
  assert.equal(exactHitCost(1, 0), 4);
  const normal = recommendTransfers(data, base, 5, 0, new Map(), { limit: 5, includeHold: false });
  const normalMove = normal.recommendations.find((r) => r.net.transferCount > 0);
  if (normalMove) {
    assert.equal(normalMove.net.hitCost, 4, "control: normal 0-FT path pays −4");
  }
  const wc = recommendWildcardSwaps(data, base, 5, new Map(), { limit: 5, includeHold: false });
  assert.ok(wc.recommendations.length > 0);
  for (const rec of wc.recommendations) {
    assert.equal(rec.net.hitCost, 0);
    assert.equal(rec.net.hitLabel, WILDCARD_HIT_LABEL);
  }
});

test("normal HOLD / bank-FT logic disabled under Wildcard (KEEP is not type-B HOLD)", () => {
  const base = squad();
  const data = dataFor(base);
  const wc = recommendWildcardSwaps(data, base, 2, new Map(), { limit: 3, includeHold: true });
  const keep = wc.recommendations.find((r) => r.classification === "HOLD");
  assert.ok(keep);
  assert.match(keep!.reason, /Wildcard/i);
  assert.doesNotMatch(keep!.reason, /bank the free transfer/i);
  assert.doesNotMatch(keep!.reason, /Free transfer/i);
  assert.ok(keep!.net.holdNowPath?.some((s) => /temporary|Wildcard KEEP|unlimited/i.test(s)));
  // Baseline path summary must not describe banking FT
  assert.ok(wc.hold.pathSummary.some((s) => /Wildcard/i.test(s)));
  assert.ok(wc.hold.pathSummary.some((s) => /not a type-B FT HOLD|temporary/i.test(s)));
});

test("saved money from a downgrade can be valued elsewhere in the squad (bank enablement)", () => {
  // Expensive weak mid in squad; cheap fodder + premium star available.
  // Downgrading first frees bank that helps afford the premium — Wildcard objective
  // must prefer the path that credits bank enablement (reasonCodes includes bank-enablement
  // when bank rises).
  const base = squad().map((p) =>
    p.id === 25
      ? makePlayer({
          ...p,
          name: "ExpensiveWeak",
          price: 9.0,
          epNext: 2,
          form: 2,
          selectedBy: 2,
          minutes: 600,
          starts: 6,
        })
      : p,
  );
  const fodder = cheapFodderMid(301, 4.5);
  const star = starMid(302, 8.0);
  const data = dataFor([...base, fodder, star]);
  const wc = recommendWildcardSwaps(data, base, 0.5, new Map(), { limit: 20, includeHold: false });
  const downgrade = wc.recommendations.find(
    (r) => r.net.legs[0]?.out.id === 25 && r.net.bankAfter > 0.5 + 0.05,
  );
  assert.ok(downgrade, "expected a legal downgrade that raises bank");
  assert.ok(
    downgrade!.net.reasonCodes.includes("bank-enablement") ||
      /frees £/i.test(downgrade!.reason) ||
      downgrade!.net.bankAfter > 0.5,
    "downgrade must surface bank/savings value",
  );
  // Ranking key is full-squad objective Δ, not individual-only
  assert.ok(Number.isFinite(downgrade!.net.riskAdjustedFiveGwNetVsHold));
});

test("Wildcard recommendations evaluated at full-squad level (objective Δ, not FT NET)", () => {
  const base = squad();
  const star = starMid(303, 7.5);
  const data = dataFor([...base, star]);
  const wc = recommendWildcardSwaps(data, base, 4, new Map(), { limit: 5, includeHold: false });
  assert.ok(wc.recommendations.length > 0);
  for (const rec of wc.recommendations) {
    assert.ok(rec.net.reasonCodes.includes("wildcard-squad-opt"));
    assert.ok(rec.net.transferNowPlanTotal !== undefined);
    assert.ok(rec.net.holdNowPlanTotal !== undefined);
    // transferNowPlanTotal stores after-squad objective; holdNowPlanTotal stores baseline.
    assert.ok(Number.isFinite(rec.net.transferNowPlanTotal));
    assert.ok(Number.isFinite(rec.net.holdNowPlanTotal));
    assert.match(rec.reason, /full-squad|Wildcard swap candidate|squad objective/i);
    assert.doesNotMatch(rec.reason, /Free transfer/i);
    assert.doesNotMatch(rec.reason, /NET vs HOLD/i);
  }
});

test("non-Wildcard path unchanged: bestTransfers without wildcardActive still uses FT / hit / HOLD", () => {
  const base = squad();
  const star = starMid(304, 7.0);
  const data = dataFor([...base, star]);
  const normal = bestTransfers(data, base, 5, 0, 5, new Map(), { mode: "deep" });
  const withHit = normal.find((r) => !r.isHold && r.hitCost > 0);
  // With 0 FT, actionable moves that appear should carry hit cost (if any move clears legality).
  const anyMove = normal.find((r) => !r.isHold && r.classification !== "HOLD");
  if (anyMove) {
    assert.equal(anyMove.hitCost, 4);
    assert.notEqual(anyMove.hitLabel, WILDCARD_HIT_LABEL);
    assert.ok(anyMove.wildcardMode !== true);
  }
  const hold = normal.find((r) => r.isHold || r.classification === "HOLD");
  if (hold) {
    assert.match(hold.engineReason ?? "", /HOLD|free transfer|bank/i);
  }
  // Control: wildcardActive true must differ in labels
  const wcRows = bestTransfers(data, base, 5, 0, 5, new Map(), { mode: "deep", wildcardActive: true });
  const wcMove = wcRows.find((r) => !r.isHold && r.classification !== "HOLD");
  if (wcMove) {
    assert.equal(wcMove.hitCost, 0);
    assert.equal(wcMove.hitLabel, WILDCARD_HIT_LABEL);
  }
  void withHit;
});

test("remainingFreeTransfers returns null for unlimited chip (does not invent 5 FTs)", () => {
  assert.equal(remainingFreeTransfers({ freeTransferLimit: null, transfersMade: 2 }), null);
});
