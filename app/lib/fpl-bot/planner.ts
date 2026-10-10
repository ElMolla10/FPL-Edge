/**
 * Turns the live bot team + the site's own FplData into a full gameweek plan: chip, transfers, starting XI, bench
 * order, captain and vice. Reuses the existing engine end to end - nothing here is a parallel model:
 *
 *   transfers   rankTransfersForBestDecision (deep, limit 60 + model utility) -> selectBestDecision  (= Transfers "BEST DECISION")
 *   WC / FH     createOptimizer(...).optimize()   (= Draft Lab "Build best squad") on the bot's real budget
 *   chips       chipScoresForEvent + scheduleChipsWithPlans (= Chips tab / Final check portfolio)
 *   lineup      bestXi + benchOrderForEvent, captain/vice by model xPts (same metrics Overview uses)
 *
 * Pure (no fetch, no D1). The runner decides whether a plan is only logged (shadow) or submitted (live).
 */
import { FplData, FplEvent, FplPlayer, PROJECTION_MODEL_VERSION, bestXi, futureEvents, projectionMetrics } from "../fpl";
import { benchOrderForEvent, rankTransfersForBestDecision } from "../best-decision";
import { createOptimizer, type HorizonMode } from "../optimizer";
import { selectBestDecision, type Transfer } from "../transfers";
import { chipScoresForEvent, type Chip } from "../chip-scores";
import { scheduleChipsWithPlans, type ChipPortfolioCandidate } from "../chip-portfolio";
import { DEFAULT_TRANSFER_RULES_2026_27 } from "../transfer-engine/rules";
import { remainingFreeTransfers } from "../personal-fpl-transfer/ft-state";
import type { ChipPolicy, HitPolicy } from "./config";
import type { PickChip, PlannedLeg, PlannedLineup, TransferChip } from "./payloads";
import { chipAvailable, pendingChip, type ElementInfo } from "./validate";
import type { BotMyTeam, OfficialChip } from "./types";

/** Server budget: the deterministic node cap (6000) decides, not the browser's 180 ms wall clock. */
export const BOT_PLAN_TIME_BUDGET_MS = 120_000;

export const CHIP_GUARDS = Object.freeze({
  wildcardMinGain5: 12,
  wildcardFlaggedMinGain5: 6,
  freeHitMinGain1: 10,
  freeHitBlankMinGain1: 6,
  freeHitLastChanceMinGain1: 3,
  /**
   * Bench Boost weak-bench guard: NET bench value (bench xPts minus the expected autosub points that bench would earn
   * without the chip, from benchOrderForEvent) must reach this.
   */
  benchBoostMinBenchXpts: 8,
  /**
   * Bench Boost: start-probability floor for each of the three OUTFIELD bench players. The bench GK is judged by its own
   * slot instead (available + has a fixture; its points are already in the net bench value): a backup keeper's start
   * probability (~0.16) says nothing about whether the boost is worth playing.
   */
  benchBoostMinStartProb: 0.7,
  tripleCaptainMinXpts: 9,
  /**
   * Expiry rule (P1): a chip window is "tight" at GW t when the unused chips that expire by its last GW E (pending
   * included) exceed the remaining GWs t..E minus this buffer. A tight window plays at most one chip per GW in the
   * reserved GWs and keeps one GW spare for a missed step / late-news cancel. 4 chips -> from GW E-4; 1 chip -> GW E-1.
   */
  expiryBufferGws: 2,
  /**
   * Expiry rule: an estimated chip value at or below this is treated as "no value" (projections of ruled-out players
   * stay ~0.5-1 xPts, not exactly 0). Used identically for activation and for the late-news cancel, so they cannot disagree.
   */
  expiryMinValue: 1,
  /**
   * Bench Boost outside an expiry window (P1, until P2's value model): the ordinary guard is NOT enough on its own.
   * A normal-week BB also needs an exceptional week: a confirmed double for >= benchBoostExceptionalDgwBench of the 4
   * bench players (both fixtures in the official fixture list with this event id), or a net bench value >= this bar.
   * Rationale: this squad's ordinary single-GW bench nets ~7-12 xPts, and the chip portfolio's pick week is noisy, so
   * clearing 8 says nothing about whether a better week is coming. 16 is ~2x the ordinary bar - roughly what a bench
   * of four secure starters with doubles or very easy fixtures produces - and the expiry rule still guarantees BB is
   * used before GW19 if no such week appears.
   */
  benchBoostExceptionalNetXpts: 16,
  benchBoostExceptionalDgwBench: 3,
  incomingMinChance: 75,
  hitMinStartProb: DEFAULT_TRANSFER_RULES_2026_27.makeStartProbability,
  hitMinConfidence: DEFAULT_TRANSFER_RULES_2026_27.makeConfidence,
});

const OFFICIAL_NAMES: readonly OfficialChip[] = ["wildcard", "freehit", "bboost", "3xc"];
const APP_CHIP: Record<OfficialChip, Chip> = { wildcard: "Wildcard", freehit: "Free Hit", bboost: "Bench Boost", "3xc": "Triple Captain" };
const OFFICIAL: Record<Chip, OfficialChip> = { Wildcard: "wildcard", "Free Hit": "freehit", "Bench Boost": "bboost", "Triple Captain": "3xc" };

export class PlanError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PlanError";
  }
}

export type PlanInput = {
  data: FplData;
  myTeam: BotMyTeam;
  event: FplEvent;
  hitPolicy: HitPolicy;
  chipPolicy: ChipPolicy;
  /** Hit points the bot took in the previous 3 GWs. */
  recentHitPoints: number;
  /** false for the lineup step and the "final" window: no transfers, no WC/FH. */
  allowTransfers: boolean;
  /** May newly activate Bench Boost / Triple Captain (false in the "final" window: late news can only cancel). */
  allowNewTeamChip?: boolean;
  /**
   * New team before its first deadline: unlimited free transfers, so the bot rebuilds the best 15 on its real budget
   * from fully available players only (status a, chance >= 75) and never plays a chip.
   */
  preFirstDeadline?: boolean;
};

export type BotPlan = {
  gw: number;
  transferChip: TransferChip;
  legs: PlannedLeg[];
  hitCost: number;
  lineupChip: PickChip;
  lineup: PlannedLineup;
  finalSquad: number[];
  freeTransfers: number | null;
  reasons: string[];
  engine: { classification: string | null; riskAdjustedNet5: number | null; outId: number | null; inId: number | null } | null;
  modelVersion: string;
};

export function elementsFromData(data: FplData): Map<number, ElementInfo> {
  return new Map(
    data.players.map((p) => [p.id, { id: p.id, positionId: p.positionId, teamId: p.teamId, status: p.status, chance: p.chance, nowCost: Math.round(p.price * 10) }]),
  );
}

function squadFromTeam(data: FplData, team: BotMyTeam): FplPlayer[] {
  const byId = new Map(data.players.map((p) => [p.id, p]));
  const squad = team.picks.map((pick) => byId.get(pick.element));
  if (squad.some((p) => !p) || squad.length !== 15) throw new PlanError("unknown-player", "bot squad contains players missing from the official data");
  return squad as FplPlayer[];
}

const isAvailableIn = (p: FplPlayer) => p.status === "a" && (p.chance === null || p.chance >= CHIP_GUARDS.incomingMinChance);
const isFlagged = (p: FplPlayer) => p.status !== "a" || (p.chance !== null && p.chance < CHIP_GUARDS.incomingMinChance);

/** Full-squad rebuild on the bot's REAL budget: kept players cost their selling price, buys cost now_cost. */
/** The bot's real squad optimiser on its real budget: bank + my-team selling prices for owned players. */
function budgetedOptimizer(data: FplData, squad: FplPlayer[], bank: number, selling: Map<number, number>, mode: HorizonMode) {
  const owned = new Set(squad.map((p) => p.id));
  const budget = Math.round((bank + squad.reduce((s, p) => s + (selling.get(p.id) ?? p.price), 0)) * 10) / 10;
  const players = data.players.map((p) => (owned.has(p.id) ? { ...p, price: selling.get(p.id) ?? p.price } : p));
  const optimizer = createOptimizer({ ...data, players, rules: { ...data.rules, budget } }, mode, "Balanced", "Maximum xPts");
  const pricedById = new Map(players.map((p) => [p.id, p]));
  const byId = new Map(data.players.map((p) => [p.id, p]));
  return { optimizer, priced: squad.map((p) => pricedById.get(p.id) ?? p), unprice: (s: FplPlayer[]) => s.map((p) => byId.get(p.id) ?? p) };
}

export function rebuildSquad(data: FplData, squad: FplPlayer[], bank: number, selling: Map<number, number>, mode: HorizonMode): FplPlayer[] {
  const { optimizer, unprice } = budgetedOptimizer(data, squad, bank, selling, mode);
  return unprice(optimizer.optimize().squad);
}

export type WildcardExpiryValue = {
  /** Best Wildcard squad's raw 5-GW points minus the regular (free-transfer) path's, same horizon. */
  net: number;
  wcPoints: number;
  regularPoints: number;
  source: "annealer" | "seeded search";
  squad: FplPlayer[];
  freeTransfersUsed: number;
  horizon: number[];
};

/**
 * Wildcard value for the expiry rule (P1). The annealer (optimize(), Draft Lab "Build best squad") maximises the
 * risk-adjusted objective from cheapest() restarts, so its squad can score FEWER raw points than the current squad;
 * measuring that against "do nothing" both under- and over-states a Wildcard. Here:
 * - WC squad = the better (raw 5-GW points) of the annealer's squad and a search seeded from the real squad
 *   (optimizeConstrained, up to 4 changes) - both on the real budget, both legal 15s (isValidSquad on every swap);
 * - baseline = what the bot can do WITHOUT the chip: the same seeded search limited to the free transfers it has
 *   (capped at 4; never worse than holding).
 * Cost: the annealer run is shared with the normal WC check; the two seeded searches add ~0.1-0.3 s CPU.
 */
export function wildcardExpiryValue(data: FplData, squad: FplPlayer[], bank: number, selling: Map<number, number>, freeTransfers: number, annealed: FplPlayer[]): WildcardExpiryValue {
  const { optimizer, priced, unprice } = budgetedOptimizer(data, squad, bank, selling, "Balanced 5 GWs");
  const points = (s: FplPlayer[]) => optimizer.evaluate(s).fiveWeekPoints;
  const ft = Math.max(0, Math.min(4, Math.floor(freeTransfers)));
  const regular = ft > 0 ? optimizer.optimizeConstrained(priced, { maxChanges: ft }).squad : priced;
  const regularPoints = Math.max(points(priced), points(regular));
  const seeded = optimizer.optimizeConstrained(priced, { maxChanges: 4 }).squad;
  const options = [
    { source: "annealer" as const, squad: annealed, pts: annealed.length === 15 ? points(annealed) : -Infinity },
    { source: "seeded search" as const, squad: unprice(seeded), pts: points(seeded) },
  ].sort((a, b) => b.pts - a.pts);
  const best = options[0];
  return { net: best.pts - regularPoints, wcPoints: best.pts, regularPoints, source: best.source, squad: best.squad, freeTransfersUsed: ft, horizon: optimizer.eventIds };
}

export function legsBetween(from: FplPlayer[], to: FplPlayer[]): PlannedLeg[] {
  const toIds = new Set(to.map((p) => p.id));
  const fromIds = new Set(from.map((p) => p.id));
  const outs = from.filter((p) => !toIds.has(p.id)).sort((a, b) => a.positionId - b.positionId || a.id - b.id);
  const ins = to.filter((p) => !fromIds.has(p.id)).sort((a, b) => a.positionId - b.positionId || a.id - b.id);
  if (outs.length !== ins.length) throw new PlanError("leg-mismatch", "rebuilt squad does not pair with the current squad");
  return outs.map((out, i) => {
    if (out.positionId !== ins[i].positionId) throw new PlanError("leg-mismatch", "rebuilt squad changes the position balance");
    return { outId: out.id, inId: ins[i].id };
  });
}

/** XI + bench order + captain/vice for one event (model xPts; flagged players never wear an armband if avoidable). */
export type LineupView = PlannedLineup & {
  benchStartProbs: number[];
  /** Start probabilities of the three outfield bench players (bench order). */
  outfieldBenchStartProbs: number[];
  /** Bench GK is not flagged out and has at least one fixture this GW. */
  benchGkPlayable: boolean;
  /** Gross projected bench points (GK + 3 outfield). */
  benchXpts: number;
  /** Expected points the bench earns WITHOUT Bench Boost via autosubs (benchOrderForEvent). */
  benchAutosubXpts: number;
  /** benchXpts - benchAutosubXpts: what Bench Boost actually adds. */
  benchNetXpts: number;
  captainXpts: number;
  /** The captain passes the armband rule (not i/s/u/n, chance != 0, start probability >= 0.6). */
  captainEligible: boolean;
};

export function buildLineup(squad: FplPlayer[], data: FplData, eventId: number): LineupView {
  const xi = bestXi(squad, eventId, data.fixtures, eventId).players;
  if (xi.length !== 11) throw new PlanError("no-xi", "could not form a legal starting XI");
  const rawBench = squad.filter((p) => !xi.some((x) => x.id === p.id));
  const benchOrder = benchOrderForEvent(xi, rawBench, eventId, data);
  const ordered = benchOrder.bench;
  const benchGk = ordered.find((p) => p.positionShort === "GKP");
  const benchOutfield = ordered.filter((p) => p.positionShort !== "GKP");
  if (!benchGk || benchOutfield.length !== 3) throw new PlanError("no-bench", "bench must be one GK + three outfield players");
  const metric = (p: FplPlayer) => projectionMetrics(p, eventId, data.fixtures, eventId);
  const armbandOk = (p: FplPlayer) => !["i", "s", "u", "n"].includes(p.status) && p.chance !== 0 && metric(p).startProbability >= 0.6;
  const byXpts = [...xi].sort((a, b) => metric(b).xPts - metric(a).xPts || a.id - b.id);
  const eligible = byXpts.filter(armbandOk);
  const pool = eligible.length >= 2 ? eligible : byXpts;
  const captain = pool[0];
  const vice = pool.find((p) => p.id !== captain.id) ?? byXpts.find((p) => p.id !== captain.id)!;
  const bench = [benchGk, ...benchOutfield];
  const benchXpts = bench.reduce((s, p) => s + metric(p).xPts, 0);
  const benchAutosubXpts = Math.max(0, benchOrder.expectedAutosubPoints);
  const hasFixture = data.fixtures.some((f) => f.event === eventId && (f.teamH === benchGk.teamId || f.teamA === benchGk.teamId));
  return {
    starters: xi.map((p) => p.id),
    bench: bench.map((p) => p.id),
    captainId: captain.id,
    viceId: vice.id,
    benchStartProbs: bench.map((p) => metric(p).startProbability),
    outfieldBenchStartProbs: benchOutfield.map((p) => metric(p).startProbability),
    benchGkPlayable: hasFixture && !["i", "s", "u", "n"].includes(benchGk.status) && benchGk.chance !== 0,
    benchXpts,
    benchAutosubXpts,
    benchNetXpts: benchXpts - benchAutosubXpts,
    captainXpts: metric(captain).xPts,
    captainEligible: armbandOk(captain),
  };
}

function playableXiCount(squad: FplPlayer[], data: FplData, eventId: number): number {
  return squad.filter((p) => !isFlagged(p) && data.fixtures.some((f) => f.event === eventId && (f.teamH === p.teamId || f.teamA === p.teamId))).length;
}

/** The chip portfolio (same scorer + exhaustive scheduler the Chips tab uses) over the rest of the chip window. */
function scheduledChipFor(data: FplData, squad: FplPlayer[], event: FplEvent, available: OfficialChip[], stopEvent: number): OfficialChip | null {
  if (!available.length) return null;
  const horizon = futureEvents(data, 8).filter((e) => e.id >= event.id && e.id <= stopEvent);
  if (!horizon.length || horizon[0].id !== event.id) return null;
  const candidates: ChipPortfolioCandidate[] = horizon.map((e, index) => {
    const scores = chipScoresForEvent(data, squad, e, horizon.slice(index, index + 5).map((x) => x.id), true);
    return { event: e, wildcard: scores.wildcard, freeHit: scores.freeHit, benchBoost: scores.benchBoost, tripleCaptain: scores.tripleCaptain };
  });
  const schedule = scheduleChipsWithPlans(available.map((c) => APP_CHIP[c]), candidates, []);
  const now = schedule.find((a) => a.event.id === event.id);
  return now ? OFFICIAL[now.chip] : null;
}

function chipWindowEnd(team: BotMyTeam, name: OfficialChip, event: number): number | null {
  const chip = (team.chips ?? []).find((c) => c.name === name && c.status_for_entry === "available" && (c.start_event == null || c.start_event <= event) && (c.stop_event == null || event <= c.stop_event));
  return chip ? chip.stop_event ?? 38 : null;
}

/** Last GW of a chip's window: the pending entry, else the entry available at `event`. */
function chipStopFor(team: BotMyTeam, name: OfficialChip, event: number): number | null {
  const pendingEntry = (team.chips ?? []).find((c) => c.name === name && c.is_pending === true);
  if (pendingEntry) return pendingEntry.stop_event ?? 38;
  return chipWindowEnd(team, name, event);
}

/** Normal-week Bench Boost exception (see CHIP_GUARDS.benchBoostExceptionalNetXpts). Fixtures in the official list only. */
export function benchBoostExceptional(lineup: Pick<LineupView, "bench" | "benchNetXpts">, data: Pick<FplData, "players" | "fixtures">, eventId: number): { ok: boolean; dgwBench: number } {
  const teamOf = new Map(data.players.map((p) => [p.id, p.teamId]));
  const dgwBench = lineup.bench.filter((id) => {
    const team = teamOf.get(id);
    return data.fixtures.filter((f) => f.event === eventId && (f.teamH === team || f.teamA === team)).length >= 2;
  }).length;
  return { ok: dgwBench >= CHIP_GUARDS.benchBoostExceptionalDgwBench || lineup.benchNetXpts >= CHIP_GUARDS.benchBoostExceptionalNetXpts, dgwBench };
}

/** Bench Boost weak-bench guard (normal rule): outfield bench secure, bench GK slot playable, net bench value high. */
export function benchBoostGuardOk(lineup: Pick<LineupView, "outfieldBenchStartProbs" | "benchGkPlayable" | "benchNetXpts">): boolean {
  return (
    lineup.outfieldBenchStartProbs.length === 3 &&
    lineup.outfieldBenchStartProbs.every((p) => p >= CHIP_GUARDS.benchBoostMinStartProb) &&
    lineup.benchGkPlayable &&
    lineup.benchNetXpts >= CHIP_GUARDS.benchBoostMinBenchXpts
  );
}

export type ExpiryState = {
  /** Chips (the bot may play, plus a pending one) whose window is tight at this GW; empty when nothing is urgent. */
  urgentChips: OfficialChip[];
  /** Last GW of the tight window, null when nothing is urgent. */
  windowEnd: number | null;
  /** Remaining GWs (this one included) up to windowEnd. */
  gwsLeft: number;
  /** Distinct GWs reserved for the urgent chips (one chip per GW), latest first before the spare GW. */
  reservedGws: number[];
};

/**
 * Expiry detection (P1). Uses ONLY authenticated my-team chip data (status_for_entry, is_pending, start/stop_event)
 * and the official event list - no value estimates. For each distinct window end E (earliest first) it counts the
 * chips expiring by E and the not-finished GWs t..E; the window is tight when chips > GWs - expiryBufferGws.
 * Deterministic: no wall clock.
 */
export function expiryState(team: BotMyTeam, events: readonly FplEvent[], eventId: number, chips: readonly OfficialChip[]): ExpiryState {
  const withStop = [...new Set(chips)]
    .map((chip) => ({ chip, stop: chipStopFor(team, chip, eventId) }))
    .filter((x): x is { chip: OfficialChip; stop: number } => x.stop !== null && x.stop >= eventId);
  const remaining = events.filter((e) => !e.finished && e.id >= eventId).map((e) => e.id).sort((a, b) => a - b);
  for (const end of [...new Set(withStop.map((x) => x.stop))].sort((a, b) => a - b)) {
    const inWindow = withStop.filter((x) => x.stop <= end).map((x) => x.chip);
    const ids = remaining.filter((id) => id <= end);
    if (inWindow.length > ids.length - CHIP_GUARDS.expiryBufferGws) {
      const spare = Math.max(0, CHIP_GUARDS.expiryBufferGws - 1);
      const usable = inWindow.length >= ids.length ? ids : ids.slice(0, Math.max(0, ids.length - spare));
      const reservedGws = usable.slice(Math.max(0, usable.length - inWindow.length));
      return { urgentChips: OFFICIAL_NAMES.filter((c) => inWindow.includes(c)), windowEnd: end, gwsLeft: ids.length, reservedGws };
    }
  }
  return { urgentChips: [], windowEnd: null, gwsLeft: remaining.length, reservedGws: [] };
}

type ExpiryCandidate = { chip: OfficialChip; value: number | null; finalGw: boolean };

/**
 * Which urgent chip to spend in a reserved GW. Value estimates are rough (P2 replaces them), so the order is:
 * 1. chips whose window ends THIS GW (use-or-lose) before chips that still have a later GW;
 * 2. higher estimated value (TC: captain xPts; BB: net bench xPts; FH: one-GW gain; WC: 5-GW gain);
 * 3. fixed order 3xc, bboost, freehit, wildcard.
 * `value === null` means "not safe / below its bar" (never forced). A chip with value <= expiryMinValue (~0) is never
 * forced and may expire: for TC/BB playing it would be neutral at worst, but the late-news rule cancels such a chip, so
 * activation uses the same > 0 test to stay consistent. FH/WC arrive here only after clearing their (positive) expiry
 * bar, because a bad rebuild can lose points.
 */
export function pickExpiryChip(candidates: readonly ExpiryCandidate[]): OfficialChip | null {
  const order: OfficialChip[] = ["3xc", "bboost", "freehit", "wildcard"];
  const ok = candidates.filter((c) => c.value !== null && c.value > CHIP_GUARDS.expiryMinValue);
  ok.sort((a, b) => Number(b.finalGw) - Number(a.finalGw) || (b.value ?? 0) - (a.value ?? 0) || order.indexOf(a.chip) - order.indexOf(b.chip));
  return ok[0]?.chip ?? null;
}

export function planGameweek(input: PlanInput): BotPlan {
  const { data, myTeam, event } = input;
  const reasons: string[] = [];
  const squad = squadFromTeam(data, myTeam);
  const bank = myTeam.transfers.bank / 10;
  const selling = new Map(myTeam.picks.map((p) => [p.element, p.selling_price / 10]));
  const freeTransfers = remainingFreeTransfers({ freeTransferLimit: myTeam.transfers.limit, transfersMade: myTeam.transfers.made });
  const pending = pendingChip(myTeam.chips);
  const transferChipActive = pending === "wildcard" || pending === "freehit";

  const pre = input.preFirstDeadline === true;
  const allowedChips: OfficialChip[] = (["wildcard", "freehit", "bboost", "3xc"] as OfficialChip[]).filter((c) => {
    if (pre) return false;
    if (input.chipPolicy === "none") return false;
    if (input.chipPolicy === "cancellable" && (c === "wildcard" || c === "freehit")) return false;
    return chipAvailable(myTeam.chips, c, event.id) && !(c === "freehit" && event.id === 1);
  });
  const windowEnd = Math.min(...allowedChips.map((c) => chipWindowEnd(myTeam, c, event.id) ?? 38), 38);
  const allowNewTeamChip = input.allowNewTeamChip ?? input.allowTransfers;
  const scheduled = (input.allowTransfers || allowNewTeamChip) && !pending ? scheduledChipFor(data, squad, event, allowedChips, windowEnd) : null;
  if (scheduled) reasons.push(`chip portfolio schedules ${scheduled} for GW${event.id}`);
  // Expiry rule (P1): chips the bot may play plus a pending one (it occupies this GW), from authenticated my-team data.
  const pendingOfficial = OFFICIAL_NAMES.find((c) => c === pending) ?? null;
  const expiry = expiryState(myTeam, data.events, event.id, pendingOfficial ? [...allowedChips, pendingOfficial] : allowedChips);
  const reservedNow = expiry.reservedGws.includes(event.id);
  const urgent = (c: OfficialChip) => reservedNow && expiry.urgentChips.includes(c) && (allowedChips.includes(c) || pending === c);
  const finalGw = (c: OfficialChip) => chipStopFor(myTeam, c, event.id) === event.id;
  if (expiry.urgentChips.length) {
    reasons.push(
      `expiry: ${expiry.urgentChips.length} chip(s) [${expiry.urgentChips.join(",")}] expire by GW${expiry.windowEnd} with ${expiry.gwsLeft} GW(s) left - reserved GWs ${expiry.reservedGws.map((g) => `GW${g}`).join(",") || "none"}${reservedNow ? ` (GW${event.id} reserved: spend one chip)` : ""}`,
    );
  }

  // ---- transfer chip (WC / FH) or an already-active one ------------------------------------------------------
  let transferChip: TransferChip = null;
  let target = null as FplPlayer[] | null;
  if (pre && input.allowTransfers) {
    if (pending) throw new PlanError("pre-first-deadline-chip", "a chip is pending on a team before its first deadline");
    const eligible = { ...data, players: data.players.filter(isAvailableIn) };
    const rebuilt = rebuildSquad(eligible, squad, bank, selling, "Balanced 5 GWs");
    if (rebuilt.length !== 15) throw new PlanError("rebuild-failed", "pre-first-deadline rebuild did not return 15 players");
    const evaluate5 = createOptimizer(data, "Balanced 5 GWs", "Balanced", "Maximum xPts").evaluate;
    const gain = evaluate5(rebuilt).fiveWeekPoints - evaluate5(squad).fiveWeekPoints;
    reasons.push(`pre-first-deadline: unlimited free transfers, rebuilt best 15 on the real budget (+${gain.toFixed(1)} pts over 5 GWs vs current)`);
    target = rebuilt;
  } else if (input.allowTransfers && (transferChipActive || (!pending && (allowedChips.includes("wildcard") || allowedChips.includes("freehit"))))) {
    const evaluate5 = createOptimizer(data, "Balanced 5 GWs", "Balanced", "Maximum xPts").evaluate;
    const flagged = squad.filter(isFlagged).length;
    // Evaluate (no side effects; cached so a chip is rebuilt at most once per plan). In a reserved expiry GW the lower
    // expiry bars apply (still clearly positive: FH >= +3 this GW; WC > +1 over 5 GWs vs the regular free-transfer path,
    // see wildcardExpiryValue); below them a WC/FH is never forced.
    // `value` is what the expiry pick compares: FH = one-GW gain; WC in an expiry GW = net vs the regular-transfer path.
    const evaluated = new Map<"wildcard" | "freehit", { ok: boolean; gain: number; value: number; rebuilt: FplPlayer[] | null }>();
    const evalChip = (chip: "wildcard" | "freehit", force: boolean) => {
      const cached = evaluated.get(chip);
      if (cached && !force) return cached;
      const rebuilt = rebuildSquad(data, squad, bank, selling, chip === "freehit" ? "GW1 Attack" : "Balanced 5 GWs");
      let result: { ok: boolean; gain: number; value: number; rebuilt: FplPlayer[] | null };
      if (rebuilt.length !== 15) result = { ok: false, gain: -Infinity, value: -Infinity, rebuilt: null };
      else if (chip === "wildcard") {
        const gain = evaluate5(rebuilt).fiveWeekPoints - evaluate5(squad).fiveWeekPoints;
        const normalOk = force || gain >= CHIP_GUARDS.wildcardMinGain5 || (flagged >= 4 && gain >= CHIP_GUARDS.wildcardFlaggedMinGain5);
        if (urgent("wildcard") && !normalOk) {
          // Expiry GW: judge the WC against what the bot does anyway (free transfers), on the best of two real searches.
          const x = wildcardExpiryValue(data, squad, bank, selling, freeTransfers ?? 0, rebuilt);
          const ok = x.net > CHIP_GUARDS.expiryMinValue;
          reasons.push(
            `wildcard rebuild: +${gain.toFixed(1)} pts over 5 GWs vs holding (${flagged} flagged); expiry check: best WC squad (${x.source}) ${x.wcPoints.toFixed(1)} vs regular ${x.freeTransfersUsed}-FT path ${x.regularPoints.toFixed(1)} over GW${x.horizon[0]}-${x.horizon[x.horizon.length - 1]} = net ${x.net >= 0 ? "+" : ""}${x.net.toFixed(1)} (bar > ${CHIP_GUARDS.expiryMinValue})${ok ? "" : " - not positive enough, not forced"}`,
          );
          result = { ok, gain, value: x.net, rebuilt: x.squad.length === 15 ? x.squad : null };
        } else {
          reasons.push(`wildcard rebuild: +${gain.toFixed(1)} pts over 5 GWs (${flagged} flagged)${normalOk ? "" : " - below the bar, not played"}`);
          result = { ok: normalOk, gain, value: gain, rebuilt };
        }
      } else {
        const gain = bestXi(rebuilt, event.id, data.fixtures, event.id).total - bestXi(squad, event.id, data.fixtures, event.id).total;
        const playable = playableXiCount(squad, data, event.id);
        const ok = force || gain >= CHIP_GUARDS.freeHitMinGain1 || (playable < 9 && gain >= CHIP_GUARDS.freeHitBlankMinGain1) || (urgent("freehit") && gain >= CHIP_GUARDS.freeHitLastChanceMinGain1);
        reasons.push(`free hit squad: +${gain.toFixed(1)} pts this GW (${playable} playable)${ok ? "" : " - below the bar, not played"}`);
        result = { ok, gain, value: gain, rebuilt };
      }
      evaluated.set(chip, result);
      return result;
    };
    const play = (chip: "wildcard" | "freehit", force: boolean): boolean => {
      const r = evalChip(chip, force);
      if (r.ok && r.rebuilt) target = r.rebuilt;
      return r.ok && Boolean(r.rebuilt);
    };
    if (transferChipActive) {
      // Chip already confirmed on FPL (e.g. an earlier tick). Finish the rebuild; never send the chip again.
      play(pending as "wildcard" | "freehit", true);
    } else if (scheduled === "wildcard" || scheduled === "freehit") {
      if (play(scheduled, false)) transferChip = scheduled;
    }
    if (!transferChip && !transferChipActive && reservedNow) {
      // Reserved expiry GW and no transfer chip yet: unless a scheduled team chip already passes its normal guard (it
      // will use this GW), spend the most useful urgent chip. TC/BB are valued on the current squad here and re-checked
      // on the final squad by the lineup step.
      const now = buildLineup(squad, data, event.id);
      const scheduledTeamChipOk = (scheduled === "bboost" && benchBoostGuardOk(now) && benchBoostExceptional(now, data, event.id).ok) || (scheduled === "3xc" && now.captainEligible && now.captainXpts >= CHIP_GUARDS.tripleCaptainMinXpts);
      if (!scheduledTeamChipOk) {
        const candidates: ExpiryCandidate[] = [];
        for (const chip of ["freehit", "wildcard"] as const) {
          if (!urgent(chip)) continue;
          const r = evalChip(chip, false);
          candidates.push({ chip, value: r.ok && r.rebuilt ? r.value : null, finalGw: finalGw(chip) });
        }
        if (urgent("3xc")) candidates.push({ chip: "3xc", value: now.captainEligible ? now.captainXpts : null, finalGw: finalGw("3xc") });
        if (urgent("bboost")) candidates.push({ chip: "bboost", value: now.benchNetXpts, finalGw: finalGw("bboost") });
        const pick = pickExpiryChip(candidates);
        if (pick === "wildcard" || pick === "freehit") {
          if (play(pick, false)) {
            transferChip = pick;
            reasons.push(`expiry rule: ${pick} spent in reserved GW${event.id} (most useful urgent chip)`);
          }
        } else if (pick) {
          reasons.push(`expiry rule: GW${event.id} kept for ${pick} (more useful than the urgent transfer chips)`);
        }
      }
    }
  }

  // ---- normal transfers (engine BEST DECISION, one move; hit only when it clearly beats HOLD) ---------------
  let legs: PlannedLeg[] = [];
  let hitCost = 0;
  let engine: BotPlan["engine"] = null;
  if (target) {
    legs = legsBetween(squad, target);
    if (!legs.length) {
      transferChip = null;
      reasons.push(pre ? "rebuilt squad equals the current squad - no transfers needed" : "rebuilt squad equals the current squad - chip not played");
    }
  } else if (input.allowTransfers && !transferChipActive) {
    const ft = freeTransfers ?? 1;
    const rows: Transfer[] = rankTransfersForBestDecision(data, squad, bank, ft, selling, createOptimizer(data), {
      rules: { planTimeBudgetMs: BOT_PLAN_TIME_BUDGET_MS },
    });
    const best = selectBestDecision(rows);
    engine = best
      ? { classification: best.classification ?? null, riskAdjustedNet5: best.riskAdjustedFiveGwNetVsHold ?? null, outId: best.out?.id ?? null, inId: best.incoming?.id ?? null }
      : null;
    const actionable = best && !best.isHold && (best.classification === "MAKE" || best.classification === "LEAN") && best.qualityStatus !== "blocked";
    if (!best || !actionable) {
      reasons.push(`engine says HOLD${freeTransfers !== null ? ` (banking, ${freeTransfers} FT)` : ""}`);
    } else if (!isAvailableIn(best.incoming)) {
      reasons.push(`engine move ${best.out.name} -> ${best.incoming.name} skipped: incoming player is flagged`);
    } else if (best.hitCost === 0) {
      legs = [{ outId: best.out.id, inId: best.incoming.id }];
      reasons.push(`free transfer ${best.out.name} -> ${best.incoming.name} (${best.classification}, net ${(best.riskAdjustedFiveGwNetVsHold ?? 0).toFixed(1)} vs hold)`);
    } else {
      const net = best.riskAdjustedFiveGwNetVsHold ?? -Infinity;
      const bar = DEFAULT_TRANSFER_RULES_2026_27.hitMakeNetThreshold + input.hitPolicy.safetyMargin;
      const ok =
        best.hitCost === 4 &&
        input.hitPolicy.maxHitsPerGw >= 1 &&
        best.classification === "MAKE" &&
        net >= bar &&
        best.startProbIn >= CHIP_GUARDS.hitMinStartProb &&
        best.confidenceIn >= CHIP_GUARDS.hitMinConfidence &&
        input.recentHitPoints + 4 <= input.hitPolicy.maxHitPointsRolling4;
      if (ok) {
        legs = [{ outId: best.out.id, inId: best.incoming.id }];
        hitCost = 4;
        reasons.push(`-4 hit ${best.out.name} -> ${best.incoming.name}: net ${net.toFixed(1)} >= ${bar.toFixed(1)} vs hold`);
      } else {
        reasons.push(`hit move ${best.out.name} -> ${best.incoming.name} declined (net ${Number.isFinite(net) ? net.toFixed(1) : "?"} < ${bar.toFixed(1)} or policy/caps)`);
      }
    }
  } else if (!input.allowTransfers) {
    reasons.push(allowNewTeamChip ? "lineup step: transfers already handled" : "final window: lineup and captain only");
  }

  const byId = new Map(data.players.map((p) => [p.id, p]));
  const finalSquad = squad.map((p) => {
    const leg = legs.find((l) => l.outId === p.id);
    return leg ? byId.get(leg.inId)! : p;
  });

  // ---- team chip (BB / TC), only when no transfer chip is played/active this GW ----------------------------
  const lineup = buildLineup(finalSquad, data, event.id);
  let lineupChip: PickChip = pending === "bboost" || pending === "3xc" ? pending : null;
  if (pre) lineupChip = null;
  else if (!transferChip && !transferChipActive && input.chipPolicy !== "none") {
    // Ordinary BB guard (kept + logged for shadow analysis) AND, outside expiry, the exceptional-week condition.
    const bbOrdinary = benchBoostGuardOk(lineup);
    const bbExceptional = benchBoostExceptional(lineup, data, event.id);
    const bbOk = bbOrdinary && bbExceptional.ok;
    const tcOk = lineup.captainEligible && lineup.captainXpts >= CHIP_GUARDS.tripleCaptainMinXpts;
    const canBB = allowedChips.includes("bboost") || pending === "bboost";
    const canTC = allowedChips.includes("3xc") || pending === "3xc";
    if (canBB) {
      reasons.push(
        `bench boost check (shadow): ordinary guard ${bbOrdinary ? "passes" : "fails"} (outfield start ${lineup.outfieldBenchStartProbs.map((p) => p.toFixed(2)).join("/")}, GK slot ${lineup.benchGkPlayable ? "ok" : "not playable"}, net ${lineup.benchNetXpts.toFixed(1)} xPts); exceptional week ${bbExceptional.ok ? "yes" : "no"} (${bbExceptional.dgwBench}/4 bench doubles, bar net >= ${CHIP_GUARDS.benchBoostExceptionalNetXpts})`,
      );
    }
    // One rule for activation AND cancellation. Normal GW: the normal guard both activates and (if it later fails)
    // cancels. Reserved expiry GW: the chip is kept unless real late news kills it - TC: no armband-eligible captain
    // (captain and alternatives ruled out / flagged) or captain value <= expiryMinValue; BB: net bench value <= expiryMinValue. The 9-xPts /
    // weak-bench thresholds never cancel a chip the expiry rule is spending.
    const lateNewsKills = (chip: "bboost" | "3xc") => (chip === "3xc" ? !lineup.captainEligible || lineup.captainXpts <= CHIP_GUARDS.expiryMinValue : lineup.benchNetXpts <= CHIP_GUARDS.expiryMinValue);
    const keepPending = (chip: "bboost" | "3xc") => (urgent(chip) ? !lateNewsKills(chip) : chip === "bboost" ? bbOk : tcOk);
    const cancelReason = (chip: "bboost" | "3xc") =>
      urgent(chip)
        ? `late news: ${chip === "bboost" ? "bench boost" : "triple captain"} cancelled under the expiry rule (${chip === "bboost" ? `net bench ${lineup.benchNetXpts.toFixed(1)} xPts` : "no armband-eligible captain"})`
        : chip === "bboost"
          ? "late news: bench boost cancelled (bench not secure or no longer an exceptional week)"
          : "late news: triple captain cancelled (captain projection fell)";
    if (allowNewTeamChip) {
      lineupChip = null;
      if (pending === "bboost" || pending === "3xc") {
        if (keepPending(pending)) lineupChip = pending;
        else reasons.push(cancelReason(pending));
      }
      if (!lineupChip) {
        if (scheduled === "bboost" && canBB && bbOk) lineupChip = "bboost";
        else if (scheduled === "3xc" && canTC && tcOk) lineupChip = "3xc";
        else if (reservedNow) {
          // (also after a pending chip was just cancelled by late news: another urgent team chip may use the GW)
          const candidates: ExpiryCandidate[] = [];
          if (urgent("3xc") && canTC) candidates.push({ chip: "3xc", value: lineup.captainEligible ? lineup.captainXpts : null, finalGw: finalGw("3xc") });
          if (urgent("bboost") && canBB) candidates.push({ chip: "bboost", value: lineup.benchNetXpts, finalGw: finalGw("bboost") });
          const pick = pickExpiryChip(candidates);
          if (pick === "3xc" || pick === "bboost") {
            lineupChip = pick;
            reasons.push(`expiry rule: ${pick} spent in reserved GW${event.id}`);
          }
        }
      }
    } else if ((lineupChip === "bboost" || lineupChip === "3xc") && !keepPending(lineupChip)) {
      reasons.push(cancelReason(lineupChip));
      lineupChip = null;
    } else if ((lineupChip === "bboost" && urgent("bboost") && !bbOk) || (lineupChip === "3xc" && urgent("3xc") && !tcOk)) {
      reasons.push(`expiry rule: keeping ${lineupChip} (below the normal threshold, no late news against it)`);
    }
    if (lineupChip) reasons.push(`${lineupChip === "bboost" ? "bench boost" : "triple captain"} (${lineupChip === "bboost" ? `bench ${lineup.benchXpts.toFixed(1)} xPts, net ${lineup.benchNetXpts.toFixed(1)} after autosubs` : `captain ${lineup.captainXpts.toFixed(1)} xPts`})`);
  }
  const captain = byId.get(lineup.captainId);
  const vice = byId.get(lineup.viceId);
  reasons.push(`captain ${captain?.name ?? lineup.captainId}, vice ${vice?.name ?? lineup.viceId}`);

  return {
    gw: event.id,
    transferChip,
    legs,
    hitCost,
    lineupChip,
    lineup: { starters: lineup.starters, bench: lineup.bench, captainId: lineup.captainId, viceId: lineup.viceId },
    finalSquad: finalSquad.map((p) => p.id),
    freeTransfers,
    reasons,
    engine,
    modelVersion: PROJECTION_MODEL_VERSION,
  };
}
