/**
 * The canonical weekly call, computed server-side for the email cron.
 *
 * NOT a parallel rule: every step below is the same shared code the Overview / Transfers screens run
 * (see app/lib/best-decision.ts), fed the same inputs the client derives:
 *
 *   squad     official picks (/api/fpl/team logic, app/lib/team-response.ts) -> data.players
 *   finance   deriveSandboxFinancialContext(squad, budget, manager)   (bank + selling prices)
 *   FT        resolveFreeTransfersFromMeta(manager, 1)   (live limit - made when known; the browser's
 *             localStorage selector is unavailable server-side, default 1 = the same default the browser uses)
 *   rank      rankTransfersForBestDecision(...)  = bestTransfers(limit 60, deep) -> withModelUtilityChange
 *   decision  selectBestDecision(rows)           = the Transfers surface "BEST DECISION"
 *   captain   resolveCaptaincy(XI, stored pick, official armband, model pick)   (same as Overview)
 *
 * DECISION CHOICE (spec: "If Home says HOLD while Transfers says MAKE, do not invent a third rule"):
 * the call is the Transfers-surface BEST DECISION, i.e. selectBestDecision() over the rows produced by
 * rankTransfersForBestDecision() (the pipeline Overview's deferred deep pass also uses). Overview's *shallow*
 * first paint is a budget-restricted preview and is deliberately NOT used. A LEAN move counts as MAKE.
 */
import type { FplData, FplPlayer } from "../fpl";
import { analysis, managerWildcardActive, rankTransfersForBestDecision, resolveFreeTransfersFromMeta } from "../best-decision";
import { buildExampleSquad } from "../example-squad";
import { resolveCaptaincy } from "../captaincy";
import { createOptimizer } from "../optimizer";
import { deriveSandboxFinancialContext, isRankingFinanceUnavailable, type ManagerMeta } from "../squad-comparison";
import { selectBestDecision } from "../transfers";

/** Deterministic search bound for the server: the engine's own node cap (6000) decides when to stop, not wall-clock. */
export const CRON_PLAN_TIME_BUDGET_MS = 120_000;
/** Version tag inside the hashed string: bump to re-baseline every user intentionally (never silently). */
export const CALL_HASH_VERSION = "v1";

export type Decision = "HOLD" | "MAKE";

export type CanonicalCall = {
  gw: number;
  decision: Decision;
  captainId: number | null;
  outId: number | null;
  inId: number | null;
  /** Sorted official-flag tokens ("id:status:chance") for the squad + recommended target. Empty = no flags. */
  flags: string[];
};

/** Names/labels for the email only. Never hashed, never stored. */
export type CallDetail = {
  captainName: string | null;
  outName: string | null;
  inName: string | null;
  reason: string;
  wildcard: boolean;
  flagged: Array<{ token: string; id: number; name: string; label: string }>;
};

export type SkipReason = "incomplete-squad" | "example-squad" | "bank-unavailable" | "engine-error";

export type CallResult =
  | { ok: true; call: CanonicalCall; detail: CallDetail }
  | { ok: false; reason: SkipReason };

export type CallInputs = {
  data: FplData;
  squadIds: number[];
  /** Official manager block (as /api/fpl/team returns it) or null for a manually saved squad. */
  manager: ManagerMeta | null;
  /** squad_data.captain_vice: the user's own saved captain / vice picks keyed by gameweek (same blob the client syncs). */
  captainVice: Record<string, { captainId?: number; viceId?: number }>;
};

const STATUS_LABEL: Record<string, string> = {
  d: "doubtful",
  i: "injured",
  s: "suspended",
  u: "unavailable",
  n: "unavailable",
};

/** Official FPL status flag: status other than "a" (available), or a chance-of-playing below 100. */
export function flagToken(player: FplPlayer): string | null {
  const chance = typeof player.chance === "number" && Number.isFinite(player.chance) ? player.chance : null;
  const flagged = player.status !== "a" || (chance !== null && chance < 100);
  return flagged ? `${player.id}:${player.status}:${chance ?? ""}` : null;
}

export function flagLabel(player: FplPlayer): string {
  const chance = typeof player.chance === "number" && Number.isFinite(player.chance) ? player.chance : null;
  const word = STATUS_LABEL[player.status] ?? (chance !== null && chance < 100 ? "doubtful" : "flagged");
  return chance !== null && chance < 100 && chance > 0 && player.status === "d" ? `${word} (${chance}%)` : word;
}

/**
 * The scope of "an official flag appeared": the whole saved 15 (the spec says "current XV") plus the recommended
 * transfer target. Narrowing to the starting XI is a one-line change here.
 */
export function flaggedPlayers(squad: readonly FplPlayer[], target: FplPlayer | null): FplPlayer[] {
  const seen = new Set<number>();
  const out: FplPlayer[] = [];
  for (const player of [...squad, ...(target ? [target] : [])]) {
    if (seen.has(player.id)) continue;
    seen.add(player.id);
    if (flagToken(player)) out.push(player);
  }
  return out;
}

export function sameIdSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort((x, y) => x - y);
  const right = [...b].sort((x, y) => x - y);
  return left.every((id, index) => id === right[index]);
}

/** Defence in depth: a saved squad that is exactly today's labelled demo XV is never emailed about. */
export function isExampleSquadIds(data: FplData, ids: readonly number[]): boolean {
  try {
    const example = buildExampleSquad(data).map((player) => player.id);
    return example.length === 15 && sameIdSet(example, ids);
  } catch {
    return false;
  }
}

const oneLine = (value: string, max = 220) => value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function computeCanonicalCall(inputs: CallInputs): CallResult {
  const { data, manager } = inputs;
  const byId = new Map(data.players.map((player) => [player.id, player]));
  const squad = inputs.squadIds.map((id) => byId.get(id)).filter((p): p is FplPlayer => Boolean(p));
  const a = analysis(data, squad);
  if (!a || squad.length !== 15) return { ok: false, reason: "incomplete-squad" };
  if (isExampleSquadIds(data, inputs.squadIds)) return { ok: false, reason: "example-squad" };

  const finance = deriveSandboxFinancialContext(squad, data.rules.budget, manager);
  // Same blocking rule as Transfers/Overview: a personal-entry live overlay that failed must not be ranked on a
  // public £-history bank. No invented call: the caller skips and logs.
  if (finance.source === "unavailable" || isRankingFinanceUnavailable(manager)) return { ok: false, reason: "bank-unavailable" };

  const wildcard = managerWildcardActive(manager);
  const freeTransfers = resolveFreeTransfersFromMeta(manager, 1);
  let rows;
  try {
    const optimizer = createOptimizer(data, "Balanced 5 GWs", "Balanced", "Maximum xPts");
    rows = rankTransfersForBestDecision(data, squad, finance.baselineBank, freeTransfers, finance.baselineSellingPrices, optimizer, {
      wildcardActive: wildcard,
      rules: { planTimeBudgetMs: CRON_PLAN_TIME_BUDGET_MS },
    });
  } catch {
    return { ok: false, reason: "engine-error" };
  }

  const best = selectBestDecision(rows);
  const hold = Boolean(!best || best.isHold || best.classification === "HOLD");
  const out = hold ? null : best!.out;
  const incoming = hold ? null : best!.incoming;

  const modelCaptain = a.xi.captain ?? a.xi.players[0];
  const stored = inputs.captainVice?.[String(a.first)] ?? {};
  const resolved = resolveCaptaincy(a.xi.players, Number(stored.captainId) || 0, Number(stored.viceId) || 0, manager?.captainId, manager?.viceCaptainId, modelCaptain, undefined);
  const captain = (resolved && a.xi.players.find((p) => p.id === resolved.captainId)) ?? modelCaptain ?? null;

  const flagged = flaggedPlayers(squad, incoming);
  const tokens = flagged.map((p) => flagToken(p)!).sort();

  const reason = hold
    ? (best?.engineReason ?? (wildcard ? "No Wildcard swap clears the full-squad bar." : "No move clears the 5-GW NET vs HOLD bar, so bank the free transfer."))
    : (best!.engineReason ?? `${out!.name} → ${incoming!.name} clears the risk-adjusted 5-GW NET vs HOLD bar.`);

  return {
    ok: true,
    call: {
      gw: a.first,
      decision: hold ? "HOLD" : "MAKE",
      captainId: captain?.id ?? null,
      outId: out?.id ?? null,
      inId: incoming?.id ?? null,
      flags: tokens,
    },
    detail: {
      captainName: captain?.name ?? null,
      outName: out?.name ?? null,
      inName: incoming?.name ?? null,
      reason: oneLine(reason),
      wildcard,
      flagged: flagged.map((p) => ({ token: flagToken(p)!, id: p.id, name: p.name, label: flagLabel(p) })),
    },
  };
}

/** gameweek + decision + captainId + transferOutId + transferInId + officialFlagFingerprint. */
export function canonicalCallString(call: CanonicalCall): string {
  return [CALL_HASH_VERSION, call.gw, call.decision, call.captainId ?? 0, call.outId ?? 0, call.inId ?? 0, call.flags.join("|")].join(";");
}

export async function hashCall(call: CanonicalCall): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalCallString(call));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stored as small JSON (ids only) so the next email can say "changed" / "captain is now"; see last_call_json. */
export function serializeCall(call: CanonicalCall): string {
  return JSON.stringify({ gw: call.gw, d: call.decision, c: call.captainId, o: call.outId, i: call.inId });
}

export type PreviousCall = { gw: number; decision: Decision; captainId: number | null; outId: number | null; inId: number | null };

export function parsePreviousCall(json: string | null | undefined): PreviousCall | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const gw = num(raw.gw);
    if (gw === null || (raw.d !== "HOLD" && raw.d !== "MAKE")) return null;
    return { gw, decision: raw.d, captainId: num(raw.c), outId: num(raw.o), inId: num(raw.i) };
  } catch {
    return null;
  }
}
