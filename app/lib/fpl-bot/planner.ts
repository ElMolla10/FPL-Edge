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
  wildcardLastChanceMinGain5: 4,
  freeHitMinGain1: 10,
  freeHitBlankMinGain1: 6,
  freeHitLastChanceMinGain1: 3,
  benchBoostMinBenchXpts: 8,
  benchBoostMinStartProb: 0.7,
  tripleCaptainMinXpts: 9,
  incomingMinChance: 75,
  hitMinStartProb: DEFAULT_TRANSFER_RULES_2026_27.makeStartProbability,
  hitMinConfidence: DEFAULT_TRANSFER_RULES_2026_27.makeConfidence,
});

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
export function rebuildSquad(data: FplData, squad: FplPlayer[], bank: number, selling: Map<number, number>, mode: HorizonMode): FplPlayer[] {
  const owned = new Set(squad.map((p) => p.id));
  const budget = Math.round((bank + squad.reduce((s, p) => s + (selling.get(p.id) ?? p.price), 0)) * 10) / 10;
  const players = data.players.map((p) => (owned.has(p.id) ? { ...p, price: selling.get(p.id) ?? p.price } : p));
  const optimizer = createOptimizer({ ...data, players, rules: { ...data.rules, budget } }, mode, "Balanced", "Maximum xPts");
  const result = optimizer.optimize();
  const byId = new Map(data.players.map((p) => [p.id, p]));
  return result.squad.map((p) => byId.get(p.id) ?? p);
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
export function buildLineup(squad: FplPlayer[], data: FplData, eventId: number): PlannedLineup & { benchStartProbs: number[]; benchXpts: number; captainXpts: number } {
  const xi = bestXi(squad, eventId, data.fixtures, eventId).players;
  if (xi.length !== 11) throw new PlanError("no-xi", "could not form a legal starting XI");
  const rawBench = squad.filter((p) => !xi.some((x) => x.id === p.id));
  const ordered = benchOrderForEvent(xi, rawBench, eventId, data).bench;
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
  return {
    starters: xi.map((p) => p.id),
    bench: bench.map((p) => p.id),
    captainId: captain.id,
    viceId: vice.id,
    benchStartProbs: bench.map((p) => metric(p).startProbability),
    benchXpts: bench.reduce((s, p) => s + metric(p).xPts, 0),
    captainXpts: metric(captain).xPts,
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
  const lastChance = (c: OfficialChip) => allowedChips.includes(c) && chipWindowEnd(myTeam, c, event.id) === event.id;

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
    const tryChip = (chip: "wildcard" | "freehit", force: boolean): boolean => {
      const rebuilt = rebuildSquad(data, squad, bank, selling, chip === "freehit" ? "GW1 Attack" : "Balanced 5 GWs");
      if (rebuilt.length !== 15) return false;
      if (chip === "wildcard") {
        const gain = evaluate5(rebuilt).fiveWeekPoints - evaluate5(squad).fiveWeekPoints;
        const ok = force || gain >= CHIP_GUARDS.wildcardMinGain5 || (flagged >= 4 && gain >= CHIP_GUARDS.wildcardFlaggedMinGain5) || (lastChance("wildcard") && gain >= CHIP_GUARDS.wildcardLastChanceMinGain5);
        reasons.push(`wildcard rebuild: +${gain.toFixed(1)} pts over 5 GWs (${flagged} flagged)${ok ? "" : " - below the bar, not played"}`);
        if (ok) target = rebuilt;
        return ok;
      }
      const gain = bestXi(rebuilt, event.id, data.fixtures, event.id).total - bestXi(squad, event.id, data.fixtures, event.id).total;
      const playable = playableXiCount(squad, data, event.id);
      const ok = force || gain >= CHIP_GUARDS.freeHitMinGain1 || (playable < 9 && gain >= CHIP_GUARDS.freeHitBlankMinGain1) || (lastChance("freehit") && gain >= CHIP_GUARDS.freeHitLastChanceMinGain1);
      reasons.push(`free hit squad: +${gain.toFixed(1)} pts this GW (${playable} playable)${ok ? "" : " - below the bar, not played"}`);
      if (ok) target = rebuilt;
      return ok;
    };
    if (transferChipActive) {
      // Chip already confirmed on FPL (e.g. an earlier tick). Finish the rebuild; never send the chip again.
      tryChip(pending as "wildcard" | "freehit", true);
    } else if (scheduled === "wildcard" || scheduled === "freehit") {
      if (tryChip(scheduled, false)) transferChip = scheduled;
    } else {
      for (const chip of ["freehit", "wildcard"] as const) {
        if (lastChance(chip) && tryChip(chip, false)) {
          transferChip = chip;
          break;
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
    const bbOk = lineup.benchStartProbs.every((p) => p >= CHIP_GUARDS.benchBoostMinStartProb) && lineup.benchXpts >= CHIP_GUARDS.benchBoostMinBenchXpts;
    const tcOk = lineup.captainXpts >= CHIP_GUARDS.tripleCaptainMinXpts;
    const canBB = allowedChips.includes("bboost") || pending === "bboost";
    const canTC = allowedChips.includes("3xc") || pending === "3xc";
    if (allowNewTeamChip) {
      lineupChip = null;
      if (pending === "bboost" && bbOk) lineupChip = "bboost";
      else if (pending === "3xc" && tcOk) lineupChip = "3xc";
      else if (scheduled === "bboost" && canBB && bbOk) lineupChip = "bboost";
      else if (scheduled === "3xc" && canTC && tcOk) lineupChip = "3xc";
      else if (lastChance("3xc") && canTC) lineupChip = "3xc";
      else if (lastChance("bboost") && canBB) lineupChip = "bboost";
    } else if (lineupChip === "bboost" && !bbOk) {
      lineupChip = null;
      reasons.push("late news: bench boost cancelled (bench not secure)");
    } else if (lineupChip === "3xc" && !tcOk) {
      lineupChip = null;
      reasons.push("late news: triple captain cancelled (captain projection fell)");
    }
    if (lineupChip) reasons.push(`${lineupChip === "bboost" ? "bench boost" : "triple captain"} (${lineupChip === "bboost" ? `bench ${lineup.benchXpts.toFixed(1)} xPts` : `captain ${lineup.captainXpts.toFixed(1)} xPts`})`);
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
