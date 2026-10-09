/**
 * Owner status snapshot: pure READS of the bot_* tables (the GET route must not write; the cron records heartbeats).
 * Never returns token material - only booleans, timestamps and ids/names.
 */
import { BOT_ENV, BOT_LIMITS, botEntryId, isBotEntrySameAsPersonal, parseChipPolicy, parseHitPolicy, resolveMode, type BotEnv } from "./config";
import { sessionAgeDays, sessionHealth } from "./auth";
import { nextActionTick, nextDeadlineEvent, windowFor } from "./schedule";
import { readBotAuthRow, readBotState, recentDecisions, recentErrors, recentRuns, type BotDb } from "./store";
import type { FplEvent } from "../fpl";

export async function readBotStatus(db: BotDb, env: BotEnv, events: readonly FplEvent[] | null, nowMs: number) {
  const [state, auth, decisions, runs, errors] = await Promise.all([readBotState(db), readBotAuthRow(db), recentDecisions(db, 10), recentRuns(db, 15), recentErrors(db, 10)]);
  const entry = botEntryId(env);
  const checkedAt = auth?.identity_checked_at ? Date.parse(auth.identity_checked_at) : NaN;
  const identityVerified = Boolean(entry && auth?.identity_entry === entry && Number.isFinite(checkedAt) && nowMs - checkedAt < BOT_LIMITS.identityMaxAgeMs * 2);
  const dryRunPassed = Boolean(entry && state.dry_run_entry === entry && state.dry_run_passed_at);
  const mode = resolveMode({ env, storedMode: state.mode, kill: state.kill === 1, identityVerified, dryRunPassed });
  const age = sessionAgeDays(auth, nowMs);
  const next = events ? nextDeadlineEvent(events, nowMs) : null;
  const deadlineMs = next ? Date.parse(next.deadline) : NaN;
  const tick = next ? nextActionTick(deadlineMs, nowMs) : null;
  const parse = (raw: string) => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  return {
    mode: { env: env[BOT_ENV.mode] ?? null, stored: state.mode, requested: mode.requested, effective: mode.effective, reasons: mode.reasons },
    config: {
      entryConfigured: Boolean(entry),
      entryId: entry,
      entryEqualsPersonal: isBotEntrySameAsPersonal(env),
      tokenKeyConfigured: Boolean(env[BOT_ENV.tokenKey]),
      teamNameConfigured: Boolean(env[BOT_ENV.teamName]),
      hitPolicy: parseHitPolicy(env[BOT_ENV.hitPolicy]),
      chipPolicy: parseChipPolicy(env[BOT_ENV.chipPolicy]),
    },
    session: {
      connected: Boolean(auth?.refresh_token_enc),
      startedAt: auth?.session_started_at ?? null,
      ageDays: age === null ? null : Math.round(age * 10) / 10,
      health: sessionHealth(age),
      approxDaysLeft: age === null ? null : Math.max(0, Math.round((30 - age) * 10) / 10),
      lastOkAt: auth?.last_ok_at ?? null,
      lastError: auth?.last_error ?? null,
      identityVerified,
      identityCheckedAt: auth?.identity_checked_at ?? null,
    },
    safety: {
      kill: state.kill === 1,
      killReason: state.kill_reason,
      gwKillEvent: state.gw_kill_event,
      gwKillReason: state.gw_kill_reason,
      dryRunPassedAt: dryRunPassed ? state.dry_run_passed_at : null,
    },
    lastRun: { at: state.last_tick_at, summary: state.last_tick_summary },
    nextRun: next
      ? { gw: next.id, deadline: next.deadline, windowNow: windowFor(deadlineMs, nowMs), nextTickAt: tick ? new Date(tick.atMs).toISOString() : null, nextTickWindow: tick?.window ?? null }
      : null,
    decisions: decisions.map((d) => ({ at: d.created_at, gw: d.gw, step: d.step, mode: d.mode, summary: parse(d.summary_json) })),
    runs: runs.map((r) => ({ gw: r.gw, step: r.step, status: r.status, mode: r.mode, attempt: r.attempt, error: r.error, responseStatus: r.response_status, updatedAt: r.updated_at, verifiedAt: r.verified_at })),
    errors: errors.map((e) => ({ at: e.created_at, code: e.code, detail: e.detail })),
  };
}

export type BotStatus = Awaited<ReturnType<typeof readBotStatus>>;
