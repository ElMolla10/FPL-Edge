/**
 * The bot's hourly tick (worker cron). All I/O is injected so it unit-tests without Workers, D1 or FPL.
 *
 *   lock -> keep-alive token -> identity (/api/me entry == bot entry) -> resolve mode -> load FplData -> schedule window
 *   -> [dry run] -> plan (log) -> transfers (claim, validate, POST once, verify) -> lineup (claim, compare, POST, verify)
 *   -> final lineup/captain check -> heartbeat
 *
 * Safe do-nothing fallback: any auth / data / validation / cap doubt => no POST, a logged reason, and FPL keeps the
 * previously saved team. Never blind-retries a transfer or chip: an ambiguous outcome is resolved from my-team.
 */
import type { FplData, FplEvent } from "../fpl";
import { BOT_ENV, BOT_LIMITS, assertBotEntry, botEntryId, parseChipPolicy, parseHitPolicy, resolveMode, type BotEnv, type BotMode, type ModeResolution } from "./config";
import { keepAliveBotTokens, sessionAgeDays, sessionHealth, type AuthFailure } from "./auth";
import { BotFplClient, BotHttpError, FPL_API } from "./fpl-client";
import { canonicalLineup, canonicalLineupFromTeam, canonicalSquad, canonicalTeamState, decisionHash, hashString } from "./hash";
import { buildPicksPayload, buildTransfersPayload, type PicksPayload, type TransfersPayload } from "./payloads";
import { elementsFromData, planGameweek, PlanError, type BotPlan } from "./planner";
import { nextDeadlineEvent, windowFor, type ScheduleWindow } from "./schedule";
import {
  claimRun,
  countPosts,
  getRun,
  insertDecision,
  pruneBotLogs,
  readBotAuthRow,
  readBotState,
  recordBotError,
  recordPost,
  recordTick,
  releaseBotLock,
  acquireBotLock,
  runsForEntrySince,
  setBotIdentity,
  setBotKill,
  setDryRunPassed,
  setGwKill,
  setLastAlertKey,
  updateRun,
  type BotDb,
  type BotRunRow,
  type BotStep,
} from "./store";
import type { BotMyTeam } from "./types";
import { elementsFromBootstrap, pendingChip, validatePicksPayload, validateTransfersPayload, type ElementInfo } from "./validate";

export type TickDeps = {
  env: BotEnv;
  db: BotDb;
  /** Same official snapshot the site serves (in-process /api/fpl). */
  loadData: () => Promise<FplData>;
  /** Public GET (bootstrap-static fresh before a POST, public picks fallback). */
  fetchPublicJson: (url: string) => Promise<unknown>;
  /** Used for PingOne + authenticated FPL calls. Tests inject a mock that fails on any POST. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

export type TickSummary = {
  ran: boolean;
  mode: ModeResolution | null;
  window: ScheduleWindow | null;
  gw: number | null;
  auth: "ok" | AuthFailure | "not-configured";
  actions: string[];
  errors: string[];
};

const BOOTSTRAP_URL = `${FPL_API}/bootstrap-static/`;
const FINISHED: ReadonlySet<string> = new Set(["verified", "noop", "skipped", "shadow", "failed_mismatch", "failed_ambiguous"]);

export async function runBotTick(deps: TickDeps): Promise<TickSummary> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string) => console.warn(line));
  const db = deps.db;
  const env = deps.env;
  const summary: TickSummary = { ran: false, mode: null, window: null, gw: null, auth: "not-configured", actions: [], errors: [] };
  const fail = async (code: string, detail?: string) => {
    summary.errors.push(code);
    await recordBotError(db, code, detail ?? null, now());
  };

  const holder = `tick-${now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!(await acquireBotLock(db, holder, now(), BOT_LIMITS.lockLeaseMs))) {
    log("[fpl-bot] another tick holds the lock; skipping");
    return summary;
  }
  try {
    summary.ran = true;
    const state = await readBotState(db);
    const entry = botEntryId(env);

    // ---- auth + identity ------------------------------------------------------------------------------------
    let client: BotFplClient | null = null;
    let identityVerified = false;
    let killedThisTick = false;
    const hasAuthConfig = Boolean(env[BOT_ENV.tokenKey]) && (Boolean(await readBotAuthRow(db)) || Boolean(env[BOT_ENV.refreshSeed]));
    if (hasAuthConfig) {
      const alive = await keepAliveBotTokens(env, db, now(), deps.fetchImpl);
      summary.auth = alive.ok ? "ok" : alive.reason;
      if (!alive.ok) {
        await fail(`auth-${alive.reason}`);
        await alertOnce(db, `auth-${alive.reason}`, now(), log, `bot FPL session unusable (${alive.reason}) - reconnect with the bookmarklet`);
      } else if (entry) {
        client = new BotFplClient({ entryId: assertBotEntry(env, entry), tokens: alive.tokens, fetchImpl: deps.fetchImpl, sleep: deps.sleep });
        const row = alive.row;
        const checkedAt = row.identity_checked_at ? Date.parse(row.identity_checked_at) : NaN;
        const fresh = row.identity_entry === entry && Number.isFinite(checkedAt) && now() - checkedAt < BOT_LIMITS.identityMaxAgeMs;
        if (fresh) identityVerified = true;
        else {
          try {
            const me = await client.me();
            if (me.entry === entry) {
              await setBotIdentity(db, entry, now());
              identityVerified = true;
            } else {
              await setBotIdentity(db, null, now());
              await setBotKill(db, true, me.entry ? "identity-mismatch: token belongs to another team" : "identity-unknown", now());
              killedThisTick = true;
              await fail(me.entry ? "identity-mismatch" : "identity-unknown");
              await alertOnce(db, "identity", now(), log, "bot token does not belong to the bot team - kill switch set");
              client = null;
            }
          } catch (error) {
            await fail("identity-check-failed", error instanceof Error ? error.message : undefined);
          }
        }
        const age = sessionAgeDays(row, now());
        const health = sessionHealth(age);
        if (health === "warn" || health === "stop-multistep") {
          await alertOnce(db, `session-${health}-${Math.floor(age ?? 0)}`, now(), log, `bot FPL session is ${Math.floor(age ?? 0)} days old - re-run the bookmarklet (PingOne ~30-day limit)`);
        }
      }
    }

    const dryRunPassed = Boolean(entry && state.dry_run_entry === entry && state.dry_run_passed_at);
    const mode = resolveMode({ env, storedMode: state.mode, kill: state.kill === 1 || killedThisTick, identityVerified, dryRunPassed });
    summary.mode = mode;
    if (mode.effective === "off") {
      await recordTick(db, `off (${mode.reasons.join(",") || "requested off"})`, now());
      return summary;
    }
    if (!entry) {
      await recordTick(db, "shadow: no bot entry configured yet (FPL_EDGE_BOT_FPL_ENTRY_ID)", now());
      return summary;
    }

    // ---- data + schedule ------------------------------------------------------------------------------------
    let data: FplData;
    try {
      data = await deps.loadData();
    } catch (error) {
      await fail("data-unavailable", error instanceof Error ? error.message : undefined);
      await recordTick(db, "official data unavailable - no action", now());
      return summary;
    }
    const event = nextDeadlineEvent(data.events, now());
    if (!event) {
      await recordTick(db, "no upcoming deadline", now());
      return summary;
    }
    const deadlineMs = Date.parse(event.deadline);
    const window = windowFor(deadlineMs, now());
    summary.window = window;
    summary.gw = event.id;
    const needDryRun = identityVerified && !dryRunPassed;

    if (window === "locked") {
      await markMissed(db, entry, event.id, now());
      await recordTick(db, `GW${event.id} locked (deadline < 25 min)`, now());
      return summary;
    }
    if (window === "idle" && !needDryRun) {
      if (new Date(now()).getUTCHours() === 3) await pruneBotLogs(db, now());
      await recordTick(db, `idle until GW${event.id} plan window`, now());
      return summary;
    }

    // ---- live team (authoritative) --------------------------------------------------------------------------
    let team: BotMyTeam | null = null;
    let teamSource: "my-team" | "public" = "my-team";
    try {
      if (client && identityVerified) team = await client.myTeam();
      else {
        team = await publicTeam(deps, entry, data);
        teamSource = "public";
      }
    } catch (error) {
      await fail(error instanceof BotHttpError ? `team-${error.code}` : "team-unavailable", error instanceof Error ? error.message : undefined);
    }
    if (!team) {
      await recordTick(db, `GW${event.id} ${window}: bot team unavailable - no action`, now());
      return summary;
    }

    const hitPolicy = parseHitPolicy(env[BOT_ENV.hitPolicy]);
    const chipPolicy = parseChipPolicy(env[BOT_ENV.chipPolicy]);
    const recentHitPoints = await recentHits(db, entry, event.id);
    const ctx: StepContext = { deps, db, env, entry, event, deadlineMs, now, log, summary, fail, hitPolicy, chipPolicy, recentHitPoints, client, teamSource };

    // ---- dry run (read-only rehearsal of the full submit path) ----------------------------------------------
    if (needDryRun && teamSource === "my-team") {
      const row = await claimRun(db, entry, event.id, "dryrun", "shadow", now(), BOT_LIMITS.stepLeaseMs);
      if (row) await dryRun(ctx, row, team, data);
    }

    const liveAllowed = mode.effective === "live" && teamSource === "my-team" && state.gw_kill_event !== event.id;
    const stepMode: BotMode = liveAllowed ? "live" : "shadow";

    if (window === "plan") {
      const row = await claimRun(db, entry, event.id, "plan", stepMode, now(), BOT_LIMITS.stepLeaseMs);
      if (row) await shadowStep(ctx, row, team, data, "plan");
    }
    if (window === "submit" || window === "final") {
      if (!liveAllowed) {
        const step: BotStep = window === "final" ? "final" : "transfers";
        const row = await claimRun(db, entry, event.id, step, "shadow", now(), BOT_LIMITS.stepLeaseMs);
        if (row) await shadowStep(ctx, row, team, data, step);
      } else {
        team = await liveTransfers(ctx, team, data);
        if (team) team = await liveLineup(ctx, team, data, "lineup");
        if (team && window === "final") await liveLineup(ctx, team, data, "final");
      }
    }
    await recordTick(db, `GW${event.id} ${window} mode=${mode.effective}${mode.reasons.length ? ` (${mode.reasons.join(",")})` : ""} ${summary.actions.join("; ")}`.trim(), now());
    return summary;
  } catch (error) {
    await fail("tick-crashed", error instanceof Error ? error.message : undefined);
    await recordTick(db, "tick crashed - no action", now());
    return summary;
  } finally {
    await releaseBotLock(db, holder);
  }
}

type StepContext = {
  deps: TickDeps;
  db: BotDb;
  env: BotEnv;
  entry: string;
  event: FplEvent;
  deadlineMs: number;
  now: () => number;
  log: (line: string) => void;
  summary: TickSummary;
  fail: (code: string, detail?: string) => Promise<void>;
  hitPolicy: ReturnType<typeof parseHitPolicy>;
  chipPolicy: ReturnType<typeof parseChipPolicy>;
  recentHitPoints: number;
  client: BotFplClient | null;
  teamSource: "my-team" | "public";
};

// ------------------------------------------------------------------ helpers ------------------------------------

async function alertOnce(db: BotDb, key: string, nowMs: number, log: (l: string) => void, message: string): Promise<void> {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const full = `${key}@${day}`;
  const state = await readBotState(db);
  if (state.last_alert_key === full) return;
  await setLastAlertKey(db, full, nowMs);
  await recordBotError(db, "alert", message, nowMs);
  // Cloudflare Workers Logs / observability alert on this prefix (no email channel on main yet - see docs/FPL-BOT.md).
  log(`[fpl-bot] ALERT ${message}`);
}

async function markMissed(db: BotDb, entry: string, gw: number, nowMs: number): Promise<void> {
  for (const step of ["transfers", "lineup"] as const) {
    const row = await getRun(db, entry, gw, step);
    if (row && (row.status === "pending" || row.status === "failed_retryable" || row.status === "claimed")) {
      await updateRun(db, row.id, { status: "skipped", error: "missed-deadline (FPL keeps the saved team)", lease_until: null }, nowMs);
    }
  }
}

async function recentHits(db: BotDb, entry: string, gw: number): Promise<number> {
  const rows = await runsForEntrySince(db, entry, gw - 3);
  let total = 0;
  for (const row of rows) {
    if (row.step !== "transfers" || row.status !== "verified" || row.gw >= gw) continue;
    try {
      total += Number(JSON.parse(row.summary ?? "{}").hitCost) || 0;
    } catch {
      // ignore
    }
  }
  return total;
}

/** Public fallback for shadow before the token is connected: last deadline's picks (selling price unknown => now_cost). */
async function publicTeam(deps: TickDeps, entry: string, data: FplData): Promise<BotMyTeam | null> {
  const current = data.events.find((e) => e.current) ?? [...data.events].filter((e) => e.finished).sort((a, b) => b.id - a.id)[0];
  if (!current) return null;
  const raw = (await deps.fetchPublicJson(`${FPL_API}/entry/${entry}/event/${current.id}/picks/`)) as {
    picks?: Array<{ element: number; position: number; is_captain: boolean; is_vice_captain: boolean; multiplier: number }>;
    entry_history?: { bank?: number };
  } | null;
  if (!raw?.picks || raw.picks.length !== 15) return null;
  const price = new Map(data.players.map((p) => [p.id, Math.round(p.price * 10)]));
  return {
    picks: raw.picks.map((p) => ({ ...p, selling_price: price.get(p.element) ?? 0, purchase_price: price.get(p.element) ?? 0 })),
    transfers: { bank: raw.entry_history?.bank ?? 0, limit: 1, made: 0 },
    chips: [],
  };
}

async function freshElements(ctx: StepContext): Promise<Map<number, ElementInfo>> {
  const elements = elementsFromBootstrap(await ctx.deps.fetchPublicJson(`${BOOTSTRAP_URL}?bot=${ctx.now()}`));
  if (elements.size < 300) throw new PlanError("bootstrap-unavailable", "fresh bootstrap-static unavailable");
  return elements;
}

type BuiltPlan = { plan: BotPlan; transfers: TransfersPayload | null; picks: PicksPayload; transferErrors: string[]; picksErrors: string[]; hash: string; hitCost: number; finalSquad: number[] };

async function buildAndValidate(ctx: StepContext, team: BotMyTeam, data: FplData, elements: Map<number, ElementInfo>, phase: "full" | "lineup" | "final", ignoreDeadlineGuard = false): Promise<BuiltPlan> {
  const plan = planGameweek({
    data,
    myTeam: team,
    event: ctx.event,
    hitPolicy: ctx.hitPolicy,
    chipPolicy: ctx.chipPolicy,
    recentHitPoints: ctx.recentHitPoints,
    allowTransfers: phase === "full",
    allowNewTeamChip: phase !== "final",
  });
  const nowMs = ctx.now();
  const deadlineMs = ignoreDeadlineGuard ? Number.MAX_SAFE_INTEGER : ctx.deadlineMs;
  let transfers: TransfersPayload | null = null;
  let transferErrors: string[] = [];
  let hitCost = 0;
  let finalSquad = team.picks.map((p) => p.element);
  if (plan.legs.length) {
    transfers = buildTransfersPayload({ entry: assertBotEntry(ctx.env, ctx.entry), event: ctx.event.id, legs: plan.legs, myTeam: team, elements, chip: plan.transferChip });
    const v = validateTransfersPayload(transfers, {
      botEntry: ctx.entry,
      event: ctx.event.id,
      nowMs,
      deadlineMs,
      deadlineGuardMs: BOT_LIMITS.deadlineGuardMs,
      myTeam: team,
      elements,
      freeTransfers: plan.freeTransfers,
      hitPolicy: ctx.hitPolicy,
      recentHitPoints: ctx.recentHitPoints,
    });
    transferErrors = v.errors;
    hitCost = v.hitCost;
    finalSquad = v.finalSquad;
    if (v.hitCost !== plan.hitCost) transferErrors.push(`hit cost mismatch (planner ${plan.hitCost}, validator ${v.hitCost})`);
  }
  const picks = buildPicksPayload(plan.lineup, elements, plan.lineupChip);
  const pending = pendingChip(team.chips);
  const picksErrors = validatePicksPayload(picks, {
    squadIds: finalSquad,
    elements,
    myTeam: team,
    event: ctx.event.id,
    nowMs,
    deadlineMs,
    deadlineGuardMs: BOT_LIMITS.deadlineGuardMs,
    transferChipThisGw: Boolean(plan.transferChip) || pending === "wildcard" || pending === "freehit",
  });
  const hash = await decisionHash({ gw: ctx.event.id, transfers, picks, modelVersion: plan.modelVersion });
  return { plan, transfers, picks, transferErrors, picksErrors, hash, hitCost, finalSquad };
}

function decisionSummary(built: BuiltPlan, data: FplData) {
  const name = new Map(data.players.map((p) => [p.id, p.name]));
  return {
    transfers: built.plan.legs.map((l) => ({ out: l.outId, outName: name.get(l.outId) ?? null, in: l.inId, inName: name.get(l.inId) ?? null })),
    transferChip: built.plan.transferChip,
    lineupChip: built.plan.lineupChip,
    hitCost: built.hitCost,
    captain: { id: built.plan.lineup.captainId, name: name.get(built.plan.lineup.captainId) ?? null },
    vice: { id: built.plan.lineup.viceId, name: name.get(built.plan.lineup.viceId) ?? null },
    starters: built.plan.lineup.starters,
    bench: built.plan.lineup.bench,
    reasons: built.plan.reasons,
    errors: [...built.transferErrors, ...built.picksErrors],
    freeTransfers: built.plan.freeTransfers,
  };
}

async function dryRun(ctx: StepContext, row: BotRunRow, team: BotMyTeam, data: FplData): Promise<void> {
  try {
    const elements = await freshElements(ctx);
    const built = await buildAndValidate(ctx, team, data, elements, "full", true);
    const errors = [...built.transferErrors, ...built.picksErrors];
    await insertDecision(ctx.db, { entry: ctx.entry, gw: ctx.event.id, step: "dryrun", mode: "shadow", decisionHash: built.hash, summary: decisionSummary(built, data) }, ctx.now());
    if (errors.length) {
      await updateRun(ctx.db, row.id, { status: "failed_retryable", error: errors.join("; "), decision_hash: built.hash, lease_until: null }, ctx.now());
      await ctx.fail("dry-run-failed", errors.join("; "));
      return;
    }
    await updateRun(ctx.db, row.id, { status: "verified", decision_hash: built.hash, verified_at: new Date(ctx.now()).toISOString(), lease_until: null, summary: JSON.stringify({ dryRun: true }) }, ctx.now());
    await setDryRunPassed(ctx.db, ctx.entry, ctx.now());
    ctx.summary.actions.push("dry run passed");
  } catch (error) {
    await updateRun(ctx.db, row.id, { status: "failed_retryable", error: error instanceof Error ? error.message : "dry run failed", lease_until: null }, ctx.now());
    await ctx.fail("dry-run-failed", error instanceof Error ? error.message : undefined);
  }
}

async function shadowStep(ctx: StepContext, row: BotRunRow, team: BotMyTeam, data: FplData, step: BotStep): Promise<void> {
  try {
    const elements = ctx.teamSource === "my-team" ? await freshElements(ctx) : elementsFromData(data);
    const built = await buildAndValidate(ctx, team, data, elements, step === "final" ? "final" : "full");
    const sum = decisionSummary(built, data);
    await insertDecision(ctx.db, { entry: ctx.entry, gw: ctx.event.id, step, mode: "shadow", decisionHash: built.hash, summary: { ...sum, teamSource: ctx.teamSource } }, ctx.now());
    await updateRun(
      ctx.db,
      row.id,
      {
        status: "shadow",
        decision_hash: built.hash,
        payload_json: JSON.stringify({ transfers: built.transfers, picks: built.picks }),
        summary: JSON.stringify({ hitCost: built.hitCost, reasons: built.plan.reasons }),
        error: sum.errors.length ? sum.errors.join("; ") : null,
        lease_until: null,
      },
      ctx.now(),
    );
    ctx.summary.actions.push(`shadow ${step}: ${built.plan.legs.length} transfer(s)${built.plan.transferChip ? ` +${built.plan.transferChip}` : ""}${built.plan.lineupChip ? ` +${built.plan.lineupChip}` : ""}`);
  } catch (error) {
    await updateRun(ctx.db, row.id, { status: "failed_retryable", error: error instanceof Error ? error.message : "plan failed", lease_until: null }, ctx.now());
    await ctx.fail(`shadow-${step}-failed`, error instanceof Error ? error.message : undefined);
  }
}

/** Re-checks kill switch / mode / caps immediately before a POST (D1 + env re-read). */
async function mayPost(ctx: StepContext): Promise<string | null> {
  const state = await readBotState(ctx.db);
  const auth = await readBotAuthRow(ctx.db);
  const mode = resolveMode({
    env: ctx.env,
    storedMode: state.mode,
    kill: state.kill === 1,
    identityVerified: auth?.identity_entry === ctx.entry,
    dryRunPassed: state.dry_run_entry === ctx.entry && Boolean(state.dry_run_passed_at),
  });
  if (mode.effective !== "live") return `mode is ${mode.effective} (${mode.reasons.join(",")})`;
  if (state.gw_kill_event === ctx.event.id) return "gameweek kill switch set";
  if (!(ctx.now() < ctx.deadlineMs - BOT_LIMITS.deadlineGuardMs)) return "too close to the deadline";
  const posts = await countPosts(ctx.db, ctx.entry, ctx.event.id, ctx.now());
  if (posts.gw >= BOT_LIMITS.maxPostsPerGw) return "per-gameweek POST cap reached";
  if (posts.day >= BOT_LIMITS.maxPostsPerUtcDay) return "per-day POST cap reached";
  return null;
}

const squadOf = (team: BotMyTeam) => team.picks.map((p) => p.element);

async function liveTransfers(ctx: StepContext, team: BotMyTeam, data: FplData): Promise<BotMyTeam | null> {
  const client = ctx.client!;
  const existing = await getRun(ctx.db, ctx.entry, ctx.event.id, "transfers");
  // Ambiguous previous attempt (POST sent, never verified): my-team is the truth - never re-POST blindly.
  if (existing && existing.status === "posted") {
    const target = existing.target_state_hash;
    const actual = await hashString(canonicalSquad(squadOf(team)));
    if (target && actual === target) {
      await updateRun(ctx.db, existing.id, { status: "verified", verified_at: new Date(ctx.now()).toISOString(), lease_until: null }, ctx.now());
      ctx.summary.actions.push("transfers verified (previous tick)");
    } else {
      await updateRun(ctx.db, existing.id, { status: "failed_ambiguous", error: "transfer POST outcome unknown and squad does not match the target", lease_until: null }, ctx.now());
      await setGwKill(ctx.db, ctx.event.id, "ambiguous transfer outcome", ctx.now());
      await ctx.fail("transfers-ambiguous");
      await alertOnce(ctx.db, `ambiguous-${ctx.event.id}`, ctx.now(), ctx.log, `GW${ctx.event.id}: transfer outcome unclear - bot stopped for this gameweek`);
      return null;
    }
    return team;
  }
  const row = await claimRun(ctx.db, ctx.entry, ctx.event.id, "transfers", "live", ctx.now(), BOT_LIMITS.stepLeaseMs);
  if (!row) return team; // already done / owned by another tick
  try {
    const health = sessionHealth(sessionAgeDays(await readBotAuthRow(ctx.db), ctx.now()));
    if (health === "stop-multistep") {
      await updateRun(ctx.db, row.id, { status: "skipped", error: "session >= 28 days old: transfers skipped, lineup only", lease_until: null }, ctx.now());
      return team;
    }
    const elements = await freshElements(ctx);
    const built = await buildAndValidate(ctx, team, data, elements, "full");
    await insertDecision(ctx.db, { entry: ctx.entry, gw: ctx.event.id, step: "transfers", mode: "live", decisionHash: built.hash, summary: decisionSummary(built, data) }, ctx.now());
    if (!built.transfers) {
      await updateRun(ctx.db, row.id, { status: "noop", decision_hash: built.hash, summary: JSON.stringify({ hitCost: 0, reasons: built.plan.reasons }), lease_until: null }, ctx.now());
      ctx.summary.actions.push("no transfer (hold)");
      return team;
    }
    if (built.transferErrors.length) {
      await updateRun(ctx.db, row.id, { status: "skipped", decision_hash: built.hash, error: `validation: ${built.transferErrors.join("; ")}`, lease_until: null }, ctx.now());
      await ctx.fail("transfers-invalid", built.transferErrors.join("; "));
      return team;
    }
    const blocked = await mayPost(ctx);
    if (blocked) {
      await updateRun(ctx.db, row.id, { status: "skipped", decision_hash: built.hash, error: blocked, lease_until: null }, ctx.now());
      return team;
    }
    const target = await hashString(canonicalSquad(built.finalSquad));
    // Persist intent BEFORE the POST: a crash after sending is resolved from my-team on the next tick.
    await updateRun(
      ctx.db,
      row.id,
      {
        status: "posted",
        decision_hash: built.hash,
        pre_state_hash: await hashString(canonicalTeamState(team)),
        target_state_hash: target,
        payload_json: JSON.stringify(built.transfers),
        summary: JSON.stringify({ hitCost: built.hitCost, chip: built.plan.transferChip, reasons: built.plan.reasons }),
      },
      ctx.now(),
    );
    client.armPosts(true);
    let response;
    try {
      response = await client.postTransfers(built.transfers);
    } finally {
      client.armPosts(false);
    }
    await recordPost(ctx.db, ctx.entry, ctx.event.id, "transfers", response.status, ctx.now());
    await updateRun(ctx.db, row.id, { response_status: response.status, response_excerpt: response.excerpt }, ctx.now());
    const after = await client.myTeam();
    const actual = await hashString(canonicalSquad(squadOf(after)));
    const chipOk = !built.plan.transferChip || pendingChip(after.chips) === built.plan.transferChip;
    const costOk = built.plan.transferChip || typeof after.transfers.cost !== "number" || after.transfers.cost <= built.hitCost;
    if (actual === target && chipOk && costOk) {
      await updateRun(ctx.db, row.id, { status: "verified", verified_at: new Date(ctx.now()).toISOString(), lease_until: null }, ctx.now());
      ctx.summary.actions.push(`transfers verified (${built.plan.legs.length}${built.plan.transferChip ? ` +${built.plan.transferChip}` : ""})`);
      return after;
    }
    const unchanged = (await hashString(canonicalSquad(squadOf(team)))) === actual;
    if (!response.ok && unchanged) {
      await updateRun(ctx.db, row.id, { status: row.attempt < 2 ? "failed_retryable" : "skipped", error: `FPL rejected transfers (${response.status})`, lease_until: null }, ctx.now());
      await ctx.fail("transfers-rejected", response.excerpt);
      return after;
    }
    await updateRun(ctx.db, row.id, { status: "failed_mismatch", error: "squad after POST does not match the target", lease_until: null }, ctx.now());
    await setGwKill(ctx.db, ctx.event.id, "transfer verification mismatch", ctx.now());
    await ctx.fail("transfers-mismatch");
    await alertOnce(ctx.db, `mismatch-${ctx.event.id}`, ctx.now(), ctx.log, `GW${ctx.event.id}: squad after transfers does not match the plan - bot stopped for this gameweek`);
    return null;
  } catch (error) {
    const current = await getRun(ctx.db, ctx.entry, ctx.event.id, "transfers");
    if (current?.status === "posted") {
      // Outcome unknown: leave "posted" so the next tick verifies from my-team.
      await ctx.fail("transfers-outcome-unknown", error instanceof Error ? error.message : undefined);
      return null;
    }
    await updateRun(ctx.db, row.id, { status: "failed_retryable", error: error instanceof Error ? error.message : "transfers failed", lease_until: null }, ctx.now());
    await ctx.fail("transfers-failed", error instanceof Error ? error.message : undefined);
    return null;
  }
}

async function liveLineup(ctx: StepContext, team: BotMyTeam, data: FplData, step: "lineup" | "final"): Promise<BotMyTeam | null> {
  const client = ctx.client!;
  if (step === "final") {
    const lineupRow = await getRun(ctx.db, ctx.entry, ctx.event.id, "lineup");
    if (!lineupRow || !FINISHED.has(lineupRow.status)) return team;
  }
  const row = await claimRun(ctx.db, ctx.entry, ctx.event.id, step, "live", ctx.now(), BOT_LIMITS.stepLeaseMs);
  if (!row) return team;
  try {
    const elements = await freshElements(ctx);
    const built = await buildAndValidate(ctx, team, data, elements, step === "final" ? "final" : "lineup");
    await insertDecision(ctx.db, { entry: ctx.entry, gw: ctx.event.id, step, mode: "live", decisionHash: built.hash, summary: decisionSummary(built, data) }, ctx.now());
    if (built.picksErrors.length) {
      await updateRun(ctx.db, row.id, { status: "skipped", decision_hash: built.hash, error: `validation: ${built.picksErrors.join("; ")}`, lease_until: null }, ctx.now());
      await ctx.fail(`${step}-invalid`, built.picksErrors.join("; "));
      return team;
    }
    const target = canonicalLineup(built.picks.picks, built.picks.chip);
    if (target === canonicalLineupFromTeam(team)) {
      await updateRun(ctx.db, row.id, { status: "noop", decision_hash: built.hash, lease_until: null }, ctx.now());
      ctx.summary.actions.push(`${step}: already as planned`);
      return team;
    }
    const blocked = await mayPost(ctx);
    if (blocked) {
      await updateRun(ctx.db, row.id, { status: "skipped", decision_hash: built.hash, error: blocked, lease_until: null }, ctx.now());
      return team;
    }
    const targetHash = await hashString(target);
    await updateRun(ctx.db, row.id, { status: "posted", decision_hash: built.hash, pre_state_hash: await hashString(canonicalLineupFromTeam(team)), target_state_hash: targetHash, payload_json: JSON.stringify(built.picks) }, ctx.now());
    client.armPosts(true);
    let response;
    try {
      response = await client.postPicks(built.picks);
    } finally {
      client.armPosts(false);
    }
    await recordPost(ctx.db, ctx.entry, ctx.event.id, step, response.status, ctx.now());
    await updateRun(ctx.db, row.id, { response_status: response.status, response_excerpt: response.excerpt }, ctx.now());
    const after = await client.myTeam();
    if ((await hashString(canonicalLineupFromTeam(after))) === targetHash) {
      await updateRun(ctx.db, row.id, { status: "verified", verified_at: new Date(ctx.now()).toISOString(), lease_until: null }, ctx.now());
      ctx.summary.actions.push(`${step} verified`);
      return after;
    }
    if (!response.ok) {
      // Lineup POSTs are idempotent (same picks), so one retry next tick is safe.
      await updateRun(ctx.db, row.id, { status: row.attempt < 2 ? "failed_retryable" : "skipped", error: `FPL rejected picks (${response.status})`, lease_until: null }, ctx.now());
      await ctx.fail(`${step}-rejected`, response.excerpt);
      return after;
    }
    await updateRun(ctx.db, row.id, { status: "failed_mismatch", error: "lineup after POST does not match the target", lease_until: null }, ctx.now());
    await setGwKill(ctx.db, ctx.event.id, "lineup verification mismatch", ctx.now());
    await ctx.fail(`${step}-mismatch`);
    await alertOnce(ctx.db, `lineup-mismatch-${ctx.event.id}`, ctx.now(), ctx.log, `GW${ctx.event.id}: lineup after POST does not match the plan - bot stopped for this gameweek`);
    return null;
  } catch (error) {
    await updateRun(ctx.db, row.id, { status: "failed_retryable", error: error instanceof Error ? error.message : "lineup failed", lease_until: null }, ctx.now());
    await ctx.fail(`${step}-failed`, error instanceof Error ? error.message : undefined);
    return null;
  }
}
