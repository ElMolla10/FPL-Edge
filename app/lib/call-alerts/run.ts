/**
 * Hourly email-alert job (worker cron). All I/O is injected so it unit-tests without Workers, Resend or FPL.
 *
 * Per run:  config check (inert without secrets) -> ONE official snapshot -> for each opted-in user (bounded,
 * fairly rotated): load official squad -> compute the canonical call -> hash -> daily-cap policy -> send ->
 * persist. A user's failure is logged and never stops the batch; a transport "fatal" (auth/rate-limit) stops
 * sending but nothing else breaks. Writes happen ONLY after a successful send, so a failed send is retried next hour.
 */
import type { FplData } from "../fpl";
import { SITE_URL } from "../site";
import { computeCanonicalCall, hashCall, isExampleSquadIds, parsePreviousCall, serializeCall, type SkipReason } from "./call";
import { composeEmail, appShellLink } from "./email";
import { decideSend, utcDate } from "./policy";
import { createResendTransport, readAlertConfig, type AlertEnv, type MailTransport } from "./resend";
import type { TeamLoader } from "./fpl-team";

export type AlertDb = {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
    };
  };
};

export type AlertLogger = (message: string) => void;

export type RunDeps = {
  db: AlertDb;
  /** One official snapshot per run (the /api/fpl payload: bootstrap + fixtures + live-event cache). */
  loadData: () => Promise<FplData>;
  makeTeamLoader: (data: FplData) => TeamLoader;
  /** Test seam: replaces the Resend HTTP transport. */
  transport?: MailTransport;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: AlertLogger;
};

export type RunSummary = {
  enabled: boolean;
  considered: number;
  sent: number;
  skipped: Record<string, number>;
  failed: number;
};

/** Users evaluated per hourly run (each costs ~3 official FPL requests + one deep ranking). Rotated by last_checked_at. */
export const MAX_USERS_PER_RUN = 25;
/** Resend allows ~2 requests/s per team: space sends out. */
export const SEND_SPACING_MS = 600;
/** Stop starting new users after this much wall time so one slow run cannot overlap the next hour. */
export const RUN_DEADLINE_MS = 10 * 60_000;

type PrefRow = {
  user_id: string;
  email: string;
  last_call_hash: string | null;
  last_call_json: string | null;
  emails_sent_utc_date: string | null;
  emails_sent_today: number | null;
  last_flag_fingerprint: string | null;
  entry: string | null;
  squad_ids: string | null;
  captain_vice: string | null;
};

const SELECT_OPTED_IN = `
  SELECT p.user_id AS user_id, u.email AS email, p.last_call_hash AS last_call_hash, p.last_call_json AS last_call_json,
         p.emails_sent_utc_date AS emails_sent_utc_date, p.emails_sent_today AS emails_sent_today,
         p.last_flag_fingerprint AS last_flag_fingerprint, s.entry AS entry, s.squad_ids AS squad_ids, s.captain_vice AS captain_vice
    FROM notification_prefs p
    JOIN users u ON u.id = p.user_id
    JOIN squad_data s ON s.user_id = p.user_id
   WHERE p.notify_call_changes = 1
   ORDER BY COALESCE(p.last_checked_at, '') ASC, p.user_id ASC
   LIMIT ?`;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function parseIds(raw: string | null): number[] {
  try {
    const value = JSON.parse(raw ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is number => typeof id === "number" && Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}

function parseObject(raw: string | null): Record<string, { captainId?: number; viceId?: number }> {
  try {
    const value = JSON.parse(raw ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export async function runCallAlerts(env: AlertEnv, deps: RunDeps): Promise<RunSummary> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const summary: RunSummary = { enabled: false, considered: 0, sent: 0, skipped: {}, failed: 0 };
  const skip = (reason: string) => {
    summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
  };

  // 1. Inert without secrets: no DB read, no FPL request, no user touched. One log line per run.
  const configured = readAlertConfig(env, SITE_URL);
  if (!configured.ok) {
    log(configured.reason === "missing-secrets" ? "[call-alerts] disabled: RESEND_API_KEY/RESEND_FROM not set (no-op)" : "[call-alerts] disabled: RESEND_FROM is not a sender we can use (must be on a domain verified in Resend, not workers.dev)");
    return summary;
  }
  summary.enabled = true;
  const { config } = configured;
  const transport = deps.transport ?? createResendTransport(config);
  const startedAt = now();

  let rows: PrefRow[];
  try {
    rows = (await deps.db.prepare(SELECT_OPTED_IN).bind(MAX_USERS_PER_RUN).all<PrefRow>()).results ?? [];
  } catch (error) {
    // e.g. migration 0011 not applied yet: not an error worth throwing from cron.
    log(`[call-alerts] skipped: cannot read preferences (${error instanceof Error ? error.message.slice(0, 80) : "error"})`);
    return summary;
  }
  if (!rows.length) {
    log("[call-alerts] no opted-in users");
    return summary;
  }

  let data: FplData;
  try {
    data = await deps.loadData();
  } catch (error) {
    log(`[call-alerts] skipped: official FPL snapshot unavailable (${error instanceof Error ? error.name : "error"})`);
    return summary;
  }
  const loadTeam = deps.makeTeamLoader(data);
  let transportStopped = false;
  let sendsThisRun = 0;

  for (const row of rows) {
    if (now() - startedAt > RUN_DEADLINE_MS) {
      skip("run-deadline");
      continue;
    }
    summary.considered++;
    const checkedAt = new Date(now()).toISOString();
    const touch = async () => {
      try {
        await deps.db.prepare("UPDATE notification_prefs SET last_checked_at = ? WHERE user_id = ? AND notify_call_changes = 1").bind(checkedAt, row.user_id).run();
      } catch {
        /* rotation is best effort */
      }
    };
    try {
      const outcome = await evaluateUser(row);
      if (outcome !== "sent") skip(outcome);
    } catch (error) {
      summary.failed++;
      log(`[call-alerts] user ${row.user_id.slice(0, 8)} failed: ${error instanceof Error ? error.name : "error"}`);
    }
    await touch();
  }

  async function evaluateUser(row: PrefRow): Promise<string> {
    if (!row.email) return "no-email";
    const savedIds = parseIds(row.squad_ids);
    if (savedIds.length !== 15) return "no-saved-squad";
    // Demo / example squad can never reach the server through the app (persistence.ts skips it), but a hand-made
    // request could try: exclude it explicitly. Checked again on the final live squad below.
    if (isExampleSquadIds(data, savedIds)) return "example-squad";
    // Real squad = a CONNECTED official FPL team (entry id). Manually drafted squads have no official bank, and the
    // Transfers surface refuses to rank without one, so there is no honest call to email.
    const entry = (row.entry ?? "").trim();
    if (!/^\d{1,16}$/.test(entry)) return "no-connected-team";

    const team = await loadTeam({ entry, email: row.email });
    if (!team.ok) {
      log(`[call-alerts] user ${row.user_id.slice(0, 8)} skipped: official team unavailable (${team.reason})`);
      return "team-unavailable";
    }
    const computed = computeCanonicalCall({ data, squadIds: team.playerIds, manager: team.manager, captainVice: parseObject(row.captain_vice) });
    if (!computed.ok) {
      const reason: SkipReason = computed.reason;
      log(`[call-alerts] user ${row.user_id.slice(0, 8)} skipped: ${reason}`);
      return reason;
    }
    const hash = await hashCall(computed.call);
    const nowMs = now();
    const decision = decideSend(
      {
        lastCallHash: row.last_call_hash,
        emailsSentUtcDate: row.emails_sent_utc_date,
        emailsSentToday: row.emails_sent_today ?? 0,
        lastFlagFingerprint: row.last_flag_fingerprint,
      },
      hash,
      computed.call.flags,
      nowMs,
    );
    if (!decision.send) return decision.reason;
    if (transportStopped) return "transport-stopped";

    if (sendsThisRun > 0) await sleep(SEND_SPACING_MS);
    sendsThisRun++;
    const email = composeEmail({ call: computed.call, detail: computed.detail, previous: parsePreviousCall(row.last_call_json), newFlag: decision.newFlag, siteUrl: config.siteUrl });
    const sent = await transport({
      to: row.email,
      subject: email.subject,
      text: email.text,
      html: email.html,
      idempotencyKey: `call-alert:${row.user_id}:${hash.slice(0, 24)}:${decision.today}`,
      settingsUrl: appShellLink(config.siteUrl),
    });
    if (!sent.ok) {
      summary.failed++;
      if (sent.fatal) transportStopped = true;
      log(`[call-alerts] user ${row.user_id.slice(0, 8)} send failed: ${sent.error}${sent.fatal ? " (stopping sends this run)" : ""}`);
      return "send-failed";
    }
    const sentAt = new Date(now()).toISOString();
    await deps.db
      .prepare(
        `UPDATE notification_prefs
            SET last_call_hash = ?, last_call_json = ?, last_email_at = ?, emails_sent_utc_date = ?, emails_sent_today = ?,
                last_flag_fingerprint = ?, updated_at = ?
          WHERE user_id = ? AND notify_call_changes = 1`,
      )
      .bind(hash, serializeCall(computed.call), sentAt, utcDate(nowMs), decision.sentToday + 1, computed.call.flags.join("|"), sentAt, row.user_id)
      .run();
    summary.sent++;
    return "sent";
  }

  log(`[call-alerts] done considered=${summary.considered} sent=${summary.sent} failed=${summary.failed} skipped=${JSON.stringify(summary.skipped)}`);
  return summary;
}
