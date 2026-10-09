/**
 * Pre-POST validators against the official FPL squad rules (2026/27). Pure and independent of the engine: they take
 * the raw payload plus a fresh element map (built from bootstrap-static right before the POST) and the live my-team,
 * and return a list of violations. Any violation => the runner does NOT POST (safe do-nothing fallback).
 */
import type { HitPolicy } from "./config";
import type { PicksPayload, TransfersPayload } from "./payloads";
import type { BotMyTeam, BotMyTeamChip, OfficialChip } from "./types";

export type ElementInfo = {
  id: number;
  /** 1 GK, 2 DEF, 3 MID, 4 FWD */
  positionId: number;
  teamId: number;
  /** a | d | i | s | u | n */
  status: string;
  /** chance_of_playing_next_round (null = no flag) */
  chance: number | null;
  /** now_cost in tenths */
  nowCost: number;
};

export const SQUAD_RULES = Object.freeze({
  squadSize: 15,
  perPosition: Object.freeze({ 1: 2, 2: 5, 3: 5, 4: 3 } as Record<number, number>),
  teamLimit: 3,
  xi: Object.freeze({ gk: [1, 1], def: [3, 5], mid: [2, 5], fwd: [1, 3] } as Record<string, [number, number]>),
  hitPoints: 4,
});

const UNPLAYABLE = new Set(["i", "s", "u", "n"]);
/** Minimum chance_of_playing for any player the bot BUYS (and, before the first deadline, for every squad player). */
export const MIN_INCOMING_CHANCE = 75;
/** Fully available: status "a" and no flag below MIN_INCOMING_CHANCE. */
export function isFullyAvailable(element: ElementInfo | undefined): boolean {
  return Boolean(element) && element!.status === "a" && (element!.chance === null || element!.chance >= MIN_INCOMING_CHANCE);
}

export function validateSquadIds(ids: readonly number[], elements: ReadonlyMap<number, ElementInfo>): string[] {
  const errors: string[] = [];
  if (ids.length !== SQUAD_RULES.squadSize) errors.push(`squad must have ${SQUAD_RULES.squadSize} players (has ${ids.length})`);
  if (new Set(ids).size !== ids.length) errors.push("squad contains duplicate players");
  const byPos = new Map<number, number>();
  const byClub = new Map<number, number>();
  for (const id of ids) {
    const element = elements.get(id);
    if (!element) {
      errors.push(`unknown player ${id}`);
      continue;
    }
    byPos.set(element.positionId, (byPos.get(element.positionId) ?? 0) + 1);
    byClub.set(element.teamId, (byClub.get(element.teamId) ?? 0) + 1);
  }
  for (const [position, need] of Object.entries(SQUAD_RULES.perPosition)) {
    const have = byPos.get(Number(position)) ?? 0;
    if (have !== need) errors.push(`position ${position} needs ${need} players (has ${have})`);
  }
  for (const [club, count] of byClub) if (count > SQUAD_RULES.teamLimit) errors.push(`more than ${SQUAD_RULES.teamLimit} players from club ${club}`);
  return errors;
}

export function chipAvailable(chips: readonly BotMyTeamChip[] | undefined, name: OfficialChip, event: number): boolean {
  return (chips ?? []).some(
    (chip) =>
      chip.name === name &&
      chip.status_for_entry === "available" &&
      (chip.start_event == null || chip.start_event <= event) &&
      (chip.stop_event == null || event <= chip.stop_event),
  );
}

export function pendingChip(chips: readonly BotMyTeamChip[] | undefined): string | null {
  return (chips ?? []).find((chip) => chip.is_pending === true)?.name ?? null;
}

export type TransferValidationContext = {
  botEntry: string;
  event: number;
  nowMs: number;
  deadlineMs: number;
  deadlineGuardMs: number;
  myTeam: BotMyTeam;
  elements: ReadonlyMap<number, ElementInfo>;
  /** Remaining free transfers (live limit - made); null = unlimited window (WC/FH already active). */
  freeTransfers: number | null;
  hitPolicy: HitPolicy;
  /** Hit points already taken in the previous 3 GWs (rolling-4 cap). */
  recentHitPoints: number;
  /**
   * New team before its first deadline (my-team limit null + started_event == this event, no chip pending): FPL lets
   * the manager change the squad freely. Transfers are unlimited and free, and no chip may be sent.
   */
  preFirstDeadline?: boolean;
};

export type TransferValidation = { errors: string[]; hitCost: number; bankAfter: number; finalSquad: number[] };

export function validateTransfersPayload(payload: TransfersPayload, ctx: TransferValidationContext): TransferValidation {
  const errors: string[] = [];
  const squad = ctx.myTeam.picks.map((pick) => pick.element);
  const legs = payload.transfers;
  if (String(payload.entry) !== ctx.botEntry) errors.push("payload entry is not the bot entry");
  if (payload.event !== ctx.event) errors.push(`payload event ${payload.event} is not the next gameweek ${ctx.event}`);
  if (payload.confirmed !== true) errors.push("payload must be confirmed:true (no preview POSTs)");
  if (!(ctx.nowMs < ctx.deadlineMs - ctx.deadlineGuardMs)) errors.push("too close to (or past) the deadline");
  if (!Array.isArray(legs) || legs.length === 0) errors.push("no transfer legs");
  const pending = pendingChip(ctx.myTeam.chips);
  const chip = payload.chip;
  if (chip !== null && chip !== "wildcard" && chip !== "freehit") errors.push(`chip ${String(chip)} is not a transfer chip`);
  if (chip) {
    if (pending) errors.push(`another chip (${pending}) is already active this gameweek`);
    if (!chipAvailable(ctx.myTeam.chips, chip, ctx.event)) errors.push(`${chip} is not available for GW${ctx.event}`);
    if (chip === "freehit" && ctx.event === 1) errors.push("Free Hit cannot be played in GW1");
  }
  const pre = ctx.preFirstDeadline === true;
  if (pre) {
    if (chip !== null) errors.push("no chip may be played before the team's first deadline");
    if (pending) errors.push(`a chip (${pending}) is pending on a team that has not passed its first deadline`);
    if (ctx.myTeam.transfers.limit !== null) errors.push("pre-first-deadline mode but my-team reports a finite transfer limit");
  }
  const unlimited = pre || chip !== null || pending === "wildcard" || pending === "freehit" || ctx.freeTransfers === null;
  if (!pre && ctx.freeTransfers === null && pending !== "wildcard" && pending !== "freehit" && chip === null) {
    errors.push("free transfers unknown (unlimited window without an active WC/FH)");
  }
  const maxLegs = unlimited ? SQUAD_RULES.squadSize : (ctx.freeTransfers ?? 0) + ctx.hitPolicy.maxHitsPerGw;
  if (legs.length > maxLegs) errors.push(`too many transfers (${legs.length} > ${maxLegs})`);

  const outs = legs.map((leg) => leg.element_out);
  const ins = legs.map((leg) => leg.element_in);
  if (new Set(outs).size !== outs.length) errors.push("duplicate outgoing player");
  if (new Set(ins).size !== ins.length) errors.push("duplicate incoming player");
  let bank = ctx.myTeam.transfers.bank;
  for (const leg of legs) {
    const outPick = ctx.myTeam.picks.find((pick) => pick.element === leg.element_out);
    const incoming = ctx.elements.get(leg.element_in);
    const outgoing = ctx.elements.get(leg.element_out);
    if (!outPick) errors.push(`outgoing ${leg.element_out} is not in the squad`);
    if (squad.includes(leg.element_in)) errors.push(`incoming ${leg.element_in} is already in the squad`);
    if (!incoming) {
      errors.push(`incoming ${leg.element_in} is unknown`);
      continue;
    }
    if (incoming.status === "u" || incoming.status === "n") errors.push(`incoming ${leg.element_in} is unavailable`);
    if (incoming.chance === 0) errors.push(`incoming ${leg.element_in} has 0% chance of playing`);
    else if (!isFullyAvailable(incoming)) errors.push(`incoming ${leg.element_in} is not fully available (status ${incoming.status}, chance ${incoming.chance ?? "-"})`);
    if (outgoing && outgoing.positionId !== incoming.positionId) errors.push(`leg ${leg.element_out}->${leg.element_in} changes position`);
    if (outPick && leg.selling_price !== outPick.selling_price) errors.push(`selling price for ${leg.element_out} does not match my-team`);
    if (leg.purchase_price !== incoming.nowCost) errors.push(`purchase price for ${leg.element_in} is stale (now ${incoming.nowCost})`);
    bank += leg.selling_price - leg.purchase_price;
  }
  if (bank < 0) errors.push(`over budget by ${(-bank / 10).toFixed(1)}m`);
  const finalSquad = squad.map((id) => {
    const leg = legs.find((l) => l.element_out === id);
    return leg ? leg.element_in : id;
  });
  errors.push(...validateSquadIds(finalSquad, ctx.elements));
  if (pre) {
    const doubtful = finalSquad.filter((id) => !isFullyAvailable(ctx.elements.get(id)));
    if (doubtful.length) errors.push(`pre-first-deadline squad keeps players who are not fully available: ${doubtful.join(", ")}`);
  }

  const ft = ctx.freeTransfers ?? 0;
  const hitCost = unlimited ? 0 : Math.max(0, legs.length - ft) * SQUAD_RULES.hitPoints;
  const paid = hitCost / SQUAD_RULES.hitPoints;
  if (paid > ctx.hitPolicy.maxHitsPerGw) errors.push(`hit policy allows ${ctx.hitPolicy.maxHitsPerGw} paid transfer(s), plan needs ${paid}`);
  if (hitCost > 0 && ctx.recentHitPoints + hitCost > ctx.hitPolicy.maxHitPointsRolling4) errors.push("rolling 4-GW hit cap exceeded");
  return { errors, hitCost, bankAfter: bank, finalSquad };
}

export type PicksValidationContext = {
  squadIds: readonly number[];
  elements: ReadonlyMap<number, ElementInfo>;
  myTeam: BotMyTeam;
  event: number;
  nowMs: number;
  deadlineMs: number;
  deadlineGuardMs: number;
  /** A transfer chip (WC/FH) is being played / is active this GW: no team chip may be added. */
  transferChipThisGw: boolean;
  /** No chips at all before the team's first deadline. */
  preFirstDeadline?: boolean;
};

export function validatePicksPayload(payload: PicksPayload, ctx: PicksValidationContext): string[] {
  const errors: string[] = [];
  const picks = payload.picks;
  if (!(ctx.nowMs < ctx.deadlineMs - ctx.deadlineGuardMs)) errors.push("too close to (or past) the deadline");
  if (!Array.isArray(picks) || picks.length !== 15) return [...errors, "picks must contain exactly 15 players"];
  const ids = picks.map((pick) => pick.element);
  const squad = new Set(ctx.squadIds);
  if (new Set(ids).size !== 15) errors.push("duplicate players in picks");
  if (ids.some((id) => !squad.has(id)) || ctx.squadIds.length !== 15) errors.push("picks do not match the current squad");
  const positions = picks.map((pick) => pick.position).sort((a, b) => a - b);
  if (positions.some((position, index) => position !== index + 1)) errors.push("positions must be exactly 1..15");
  const at = (position: number) => picks.find((pick) => pick.position === position);
  const posOf = (id: number | undefined) => (id === undefined ? 0 : ctx.elements.get(id)?.positionId ?? 0);
  const starters = picks.filter((pick) => pick.position <= 11);
  const count = (positionId: number) => starters.filter((pick) => posOf(pick.element) === positionId).length;
  const ranges: Array<[string, number, [number, number]]> = [
    ["GK", 1, SQUAD_RULES.xi.gk],
    ["DEF", 2, SQUAD_RULES.xi.def],
    ["MID", 3, SQUAD_RULES.xi.mid],
    ["FWD", 4, SQUAD_RULES.xi.fwd],
  ];
  for (const [label, positionId, [min, max]] of ranges) {
    const have = count(positionId);
    if (have < min || have > max) errors.push(`starting XI needs ${min}-${max} ${label} (has ${have})`);
  }
  if (posOf(at(1)?.element) !== 1) errors.push("position 1 must be the starting goalkeeper");
  if (posOf(at(12)?.element) !== 1) errors.push("position 12 must be the substitute goalkeeper");
  const captains = picks.filter((pick) => pick.is_captain);
  const vices = picks.filter((pick) => pick.is_vice_captain);
  if (captains.length !== 1) errors.push("exactly one captain required");
  if (vices.length !== 1) errors.push("exactly one vice-captain required");
  if (captains[0] && vices[0] && captains[0].element === vices[0].element) errors.push("captain and vice must differ");
  for (const [role, pick] of [["captain", captains[0]], ["vice-captain", vices[0]]] as const) {
    if (!pick) continue;
    if (pick.position > 11) errors.push(`${role} must be in the starting XI`);
    const info = ctx.elements.get(pick.element);
    if (info && (UNPLAYABLE.has(info.status) || info.chance === 0)) errors.push(`${role} ${pick.element} is flagged out`);
  }
  const chip = payload.chip;
  if (chip !== null && chip !== "bboost" && chip !== "3xc") errors.push(`chip ${String(chip)} is not a team chip`);
  if (chip && ctx.preFirstDeadline) errors.push("no chip may be played before the team's first deadline");
  if (chip) {
    const pending = pendingChip(ctx.myTeam.chips);
    if (ctx.transferChipThisGw) errors.push("only one chip per gameweek (WC/FH already played)");
    if (pending && pending !== chip) errors.push(`another chip (${pending}) is already active this gameweek`);
    if (pending !== chip && !chipAvailable(ctx.myTeam.chips, chip, ctx.event)) errors.push(`${chip} is not available for GW${ctx.event}`);
  }
  return errors;
}

/** Element map from the raw public bootstrap-static (fetched fresh right before a POST). */
export function elementsFromBootstrap(raw: unknown): Map<number, ElementInfo> {
  const map = new Map<number, ElementInfo>();
  const elements = (raw as { elements?: unknown[] } | null)?.elements;
  if (!Array.isArray(elements)) return map;
  for (const item of elements) {
    const e = item as Record<string, unknown>;
    const id = Number(e.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const chance = e.chance_of_playing_next_round;
    map.set(id, {
      id,
      positionId: Number(e.element_type),
      teamId: Number(e.team),
      status: typeof e.status === "string" ? e.status : "u",
      chance: typeof chance === "number" && Number.isFinite(chance) ? chance : null,
      nowCost: Number(e.now_cost),
    });
  }
  return map;
}
