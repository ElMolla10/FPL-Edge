/**
 * D1 access for the bot (bot_* tables only, migration 0012_fpl_bot.sql). Takes any D1-shaped handle so it unit-tests
 * against node:sqlite. Never touches the personal FPL auth table or any other app table.
 */
import { decryptToken, encryptToken, redact, sha256Hex } from "./crypto";

export type BotRunResult = { meta?: { changes?: number } | Record<string, unknown> };
export type BotBound = {
  run(): Promise<BotRunResult>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
};
export type BotDb = { prepare(query: string): { bind(...values: unknown[]): BotBound } };

const ROW = "bot";

function changes(result: BotRunResult): number {
  const meta = result?.meta as { changes?: number } | undefined;
  return typeof meta?.changes === "number" ? meta.changes : 0;
}

const iso = (ms: number) => new Date(ms).toISOString();

// ------------------------------------------------------------------ auth --------------------------------------

export type BotAuthSession = { refreshToken: string; accessToken: string | null; accessExpiresAtMs: number | null };

export type BotAuthRow = {
  refresh_token_enc: string;
  refresh_token_hash: string;
  access_token_enc: string | null;
  access_expires_at: string | null;
  refresh_lease_until: string | null;
  session_started_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  identity_entry: string | null;
  identity_checked_at: string | null;
  updated_at: string | null;
};

export async function readBotAuthRow(db: BotDb): Promise<BotAuthRow | null> {
  return db.prepare("SELECT * FROM bot_fpl_auth WHERE id = ?").bind(ROW).first<BotAuthRow>();
}

export async function loadBotSession(db: BotDb, key: CryptoKey): Promise<BotAuthSession | null> {
  const row = await readBotAuthRow(db);
  if (!row?.refresh_token_enc) return null;
  const refreshToken = await decryptToken(key, row.refresh_token_enc);
  const accessToken = row.access_token_enc ? await decryptToken(key, row.access_token_enc) : null;
  const expires = row.access_expires_at && /^\d+$/.test(row.access_expires_at) ? Number(row.access_expires_at) : null;
  return { refreshToken, accessToken, accessExpiresAtMs: expires };
}

async function sealSession(key: CryptoKey, session: BotAuthSession) {
  return {
    refreshEnc: await encryptToken(key, session.refreshToken),
    refreshHash: await sha256Hex(session.refreshToken),
    accessEnc: session.accessToken ? await encryptToken(key, session.accessToken) : null,
    accessExpires: session.accessExpiresAtMs !== null && Number.isFinite(session.accessExpiresAtMs) ? String(Math.trunc(session.accessExpiresAtMs)) : null,
  };
}

/** Fresh interactive bootstrap (bookmarklet): replaces the row and restarts the ~30-day session clock. */
export async function storeBotBootstrap(db: BotDb, key: CryptoKey, session: BotAuthSession, identityEntry: string, nowMs: number): Promise<void> {
  const sealed = await sealSession(key, session);
  const now = iso(nowMs);
  await db
    .prepare(
      `INSERT INTO bot_fpl_auth (id, refresh_token_enc, refresh_token_hash, access_token_enc, access_expires_at, refresh_lease_until,
                                 session_started_at, last_ok_at, last_error, identity_entry, identity_checked_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET refresh_token_enc = excluded.refresh_token_enc, refresh_token_hash = excluded.refresh_token_hash,
         access_token_enc = excluded.access_token_enc, access_expires_at = excluded.access_expires_at, refresh_lease_until = NULL,
         session_started_at = excluded.session_started_at, last_ok_at = excluded.last_ok_at, last_error = NULL,
         identity_entry = excluded.identity_entry, identity_checked_at = excluded.identity_checked_at, updated_at = excluded.updated_at`,
    )
    .bind(ROW, sealed.refreshEnc, sealed.refreshHash, sealed.accessEnc, sealed.accessExpires, now, now, identityEntry, now, now)
    .run();
}

/** Compare-and-swap after a PingOne rotation. False => another caller rotated first (reload). Clears the lease. */
export async function casPersistBotSession(db: BotDb, key: CryptoKey, expectedRefreshToken: string, session: BotAuthSession, nowMs: number): Promise<boolean> {
  const sealed = await sealSession(key, session);
  const expectedHash = await sha256Hex(expectedRefreshToken);
  const result = await db
    .prepare(
      `UPDATE bot_fpl_auth SET refresh_token_enc = ?, refresh_token_hash = ?, access_token_enc = ?, access_expires_at = ?,
              refresh_lease_until = NULL, last_ok_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND refresh_token_hash = ?`,
    )
    .bind(sealed.refreshEnc, sealed.refreshHash, sealed.accessEnc, sealed.accessExpires, iso(nowMs), iso(nowMs), ROW, expectedHash)
    .run();
  if (changes(result) > 0) return true;
  const row = await readBotAuthRow(db);
  return Boolean(row && row.refresh_token_hash === sealed.refreshHash);
}

/** Last resort when CAS fails but D1 still holds the token we just spent (never leave D1 on a spent token). */
export async function forcePersistBotSession(db: BotDb, key: CryptoKey, session: BotAuthSession, nowMs: number): Promise<void> {
  const sealed = await sealSession(key, session);
  await db
    .prepare(
      `UPDATE bot_fpl_auth SET refresh_token_enc = ?, refresh_token_hash = ?, access_token_enc = ?, access_expires_at = ?,
              refresh_lease_until = NULL, last_ok_at = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(sealed.refreshEnc, sealed.refreshHash, sealed.accessEnc, sealed.accessExpires, iso(nowMs), iso(nowMs), ROW)
    .run();
}

export async function claimBotRefreshLease(db: BotDb, expectedRefreshToken: string, nowMs: number, leaseMs = 20_000): Promise<boolean> {
  const hash = await sha256Hex(expectedRefreshToken);
  const until = String(nowMs + leaseMs);
  const result = await db
    .prepare(
      `UPDATE bot_fpl_auth SET refresh_lease_until = ?, updated_at = ?
        WHERE id = ? AND refresh_token_hash = ?
          AND (refresh_lease_until IS NULL OR refresh_lease_until = '' OR CAST(refresh_lease_until AS INTEGER) < ?)`,
    )
    .bind(until, iso(nowMs), ROW, hash, nowMs)
    .run();
  if (changes(result) > 0) return true;
  const row = await readBotAuthRow(db);
  return Boolean(row && row.refresh_token_hash === hash && row.refresh_lease_until === until);
}

export async function clearBotRefreshLease(db: BotDb, expectedRefreshToken: string): Promise<void> {
  const hash = await sha256Hex(expectedRefreshToken);
  await db.prepare("UPDATE bot_fpl_auth SET refresh_lease_until = NULL WHERE id = ? AND refresh_token_hash = ?").bind(ROW, hash).run();
}

/** Seed from the optional Worker secret when D1 has no row yet (bare refresh token only). */
export async function seedBotSessionIfEmpty(db: BotDb, key: CryptoKey, seed: string | null, nowMs: number): Promise<boolean> {
  if (!seed) return false;
  const existing = await readBotAuthRow(db);
  if (existing) return false;
  const sealed = await sealSession(key, { refreshToken: seed, accessToken: null, accessExpiresAtMs: null });
  // identity_entry stays NULL: a seeded token is NOT trusted until GET /api/me proves which team it belongs to.
  await db
    .prepare(
      `INSERT OR IGNORE INTO bot_fpl_auth (id, refresh_token_enc, refresh_token_hash, session_started_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(ROW, sealed.refreshEnc, sealed.refreshHash, iso(nowMs), iso(nowMs))
    .run();
  return true;
}

export async function markBotAuth(db: BotDb, nowMs: number, error: string | null): Promise<void> {
  if (error) {
    await db.prepare("UPDATE bot_fpl_auth SET last_error = ?, updated_at = ? WHERE id = ?").bind(redact(error, 120), iso(nowMs), ROW).run();
  } else {
    await db.prepare("UPDATE bot_fpl_auth SET last_ok_at = ?, last_error = NULL, updated_at = ? WHERE id = ?").bind(iso(nowMs), iso(nowMs), ROW).run();
  }
}

export async function setBotIdentity(db: BotDb, entry: string | null, nowMs: number): Promise<void> {
  await db.prepare("UPDATE bot_fpl_auth SET identity_entry = ?, identity_checked_at = ?, updated_at = ? WHERE id = ?").bind(entry, iso(nowMs), iso(nowMs), ROW).run();
}

// ------------------------------------------------------------------ state -------------------------------------

export type BotStateRow = {
  mode: string | null;
  kill: number;
  kill_reason: string | null;
  gw_kill_event: number | null;
  gw_kill_reason: string | null;
  dry_run_passed_at: string | null;
  dry_run_entry: string | null;
  last_tick_at: string | null;
  last_tick_summary: string | null;
  last_alert_key: string | null;
  updated_at: string | null;
};

export async function readBotState(db: BotDb): Promise<BotStateRow> {
  const row = await db.prepare("SELECT * FROM bot_state WHERE id = ?").bind(ROW).first<BotStateRow>();
  return (
    row ?? {
      mode: null,
      kill: 0,
      kill_reason: null,
      gw_kill_event: null,
      gw_kill_reason: null,
      dry_run_passed_at: null,
      dry_run_entry: null,
      last_tick_at: null,
      last_tick_summary: null,
      last_alert_key: null,
      updated_at: null,
    }
  );
}

async function ensureState(db: BotDb, nowMs: number): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO bot_state (id, kill, updated_at) VALUES (?, 0, ?)").bind(ROW, iso(nowMs)).run();
}

export async function setBotMode(db: BotDb, mode: string | null, nowMs: number): Promise<void> {
  await ensureState(db, nowMs);
  await db.prepare("UPDATE bot_state SET mode = ?, updated_at = ? WHERE id = ?").bind(mode, iso(nowMs), ROW).run();
}

export async function setBotKill(db: BotDb, kill: boolean, reason: string | null, nowMs: number): Promise<void> {
  await ensureState(db, nowMs);
  await db.prepare("UPDATE bot_state SET kill = ?, kill_reason = ?, updated_at = ? WHERE id = ?").bind(kill ? 1 : 0, reason ? redact(reason, 120) : null, iso(nowMs), ROW).run();
}

export async function setGwKill(db: BotDb, gw: number | null, reason: string | null, nowMs: number): Promise<void> {
  await ensureState(db, nowMs);
  await db.prepare("UPDATE bot_state SET gw_kill_event = ?, gw_kill_reason = ?, updated_at = ? WHERE id = ?").bind(gw, reason ? redact(reason, 120) : null, iso(nowMs), ROW).run();
}

export async function setDryRunPassed(db: BotDb, entry: string | null, nowMs: number): Promise<void> {
  await ensureState(db, nowMs);
  await db.prepare("UPDATE bot_state SET dry_run_passed_at = ?, dry_run_entry = ?, updated_at = ? WHERE id = ?").bind(entry ? iso(nowMs) : null, entry, iso(nowMs), ROW).run();
}

export async function recordTick(db: BotDb, summary: string, nowMs: number): Promise<void> {
  await ensureState(db, nowMs);
  await db.prepare("UPDATE bot_state SET last_tick_at = ?, last_tick_summary = ?, updated_at = ? WHERE id = ?").bind(iso(nowMs), redact(summary, 500), iso(nowMs), ROW).run();
}

export async function setLastAlertKey(db: BotDb, key: string, nowMs: number): Promise<void> {
  await ensureState(db, nowMs);
  await db.prepare("UPDATE bot_state SET last_alert_key = ?, updated_at = ? WHERE id = ?").bind(key, iso(nowMs), ROW).run();
}

// ------------------------------------------------------------------ global lock -------------------------------

export async function acquireBotLock(db: BotDb, holder: string, nowMs: number, leaseMs: number): Promise<boolean> {
  await db.prepare("INSERT OR IGNORE INTO bot_lock (id, holder, lease_until) VALUES (?, NULL, 0)").bind(ROW).run();
  const result = await db
    .prepare("UPDATE bot_lock SET holder = ?, lease_until = ? WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)")
    .bind(holder, nowMs + leaseMs, ROW, nowMs)
    .run();
  if (changes(result) > 0) return true;
  const row = await db.prepare("SELECT holder, lease_until FROM bot_lock WHERE id = ?").bind(ROW).first<{ holder: string | null; lease_until: number | null }>();
  return Boolean(row && row.holder === holder && Number(row.lease_until) === nowMs + leaseMs);
}

export async function releaseBotLock(db: BotDb, holder: string): Promise<void> {
  await db.prepare("UPDATE bot_lock SET holder = NULL, lease_until = 0 WHERE id = ? AND holder = ?").bind(ROW, holder).run();
}

// ------------------------------------------------------------------ runs (idempotent state machine) -----------

export type BotStep = "dryrun" | "plan" | "transfers" | "lineup" | "final";
export type BotRunStatus =
  | "pending"
  | "claimed"
  | "posted"
  | "verified"
  | "noop"
  | "shadow"
  | "skipped"
  | "failed_retryable"
  | "failed_mismatch"
  | "failed_ambiguous";

export type BotRunRow = {
  id: number;
  entry: string;
  gw: number;
  step: BotStep;
  status: BotRunStatus;
  mode: string | null;
  decision_hash: string | null;
  pre_state_hash: string | null;
  target_state_hash: string | null;
  payload_json: string | null;
  summary: string | null;
  attempt: number;
  lease_until: number | null;
  response_status: number | null;
  response_excerpt: string | null;
  error: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function getRun(db: BotDb, entry: string, gw: number, step: BotStep): Promise<BotRunRow | null> {
  return db.prepare("SELECT * FROM bot_runs WHERE entry = ? AND gw = ? AND step = ?").bind(entry, gw, step).first<BotRunRow>();
}

/**
 * Exactly-once claim: INSERT the (entry, gw, step) row if absent, then take it only when it is pending / retryable and
 * not leased by someone else. Returns the claimed row, or null when another tick owns or already finished it.
 */
export async function claimRun(db: BotDb, entry: string, gw: number, step: BotStep, mode: string, nowMs: number, leaseMs: number): Promise<BotRunRow | null> {
  await db
    .prepare("INSERT OR IGNORE INTO bot_runs (entry, gw, step, status, mode, attempt, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, 0, ?, ?)")
    .bind(entry, gw, step, mode, iso(nowMs), iso(nowMs))
    .run();
  const result = await db
    .prepare(
      `UPDATE bot_runs SET status = 'claimed', mode = ?, lease_until = ?, attempt = attempt + 1, updated_at = ?
        WHERE entry = ? AND gw = ? AND step = ?
          AND ((status IN ('pending', 'failed_retryable') AND (lease_until IS NULL OR lease_until < ?))
               -- a tick that died after claiming but BEFORE marking 'posted' never sent anything: safe to take over
               OR (status = 'claimed' AND lease_until < ?))`,
    )
    .bind(mode, nowMs + leaseMs, iso(nowMs), entry, gw, step, nowMs, nowMs)
    .run();
  if (changes(result) === 0) return null;
  return getRun(db, entry, gw, step);
}

export type RunPatch = Partial<
  Pick<BotRunRow, "status" | "decision_hash" | "pre_state_hash" | "target_state_hash" | "payload_json" | "summary" | "response_status" | "response_excerpt" | "error" | "verified_at" | "lease_until">
>;

const PATCHABLE = new Set(["status", "decision_hash", "pre_state_hash", "target_state_hash", "payload_json", "summary", "response_status", "response_excerpt", "error", "verified_at", "lease_until"]);

export async function updateRun(db: BotDb, id: number, patch: RunPatch, nowMs: number): Promise<void> {
  const keys = Object.keys(patch).filter((k) => PATCHABLE.has(k));
  if (!keys.length) return;
  const values = keys.map((k) => {
    const v = (patch as Record<string, unknown>)[k];
    return typeof v === "string" && (k === "error" || k === "response_excerpt") ? redact(v, 400) : v ?? null;
  });
  await db
    .prepare(`UPDATE bot_runs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .bind(...values, iso(nowMs), id)
    .run();
}

export async function recentRuns(db: BotDb, limit = 20): Promise<BotRunRow[]> {
  return (await db.prepare("SELECT * FROM bot_runs ORDER BY id DESC LIMIT ?").bind(limit).all<BotRunRow>()).results ?? [];
}

export async function runsForEntrySince(db: BotDb, entry: string, minGw: number): Promise<BotRunRow[]> {
  return (await db.prepare("SELECT * FROM bot_runs WHERE entry = ? AND gw >= ? ORDER BY id ASC").bind(entry, minGw).all<BotRunRow>()).results ?? [];
}

// ------------------------------------------------------------------ POST accounting (caps) ---------------------

export async function recordPost(db: BotDb, entry: string, gw: number, kind: string, status: number | null, nowMs: number): Promise<void> {
  await db.prepare("INSERT INTO bot_posts (entry, gw, kind, status, created_at) VALUES (?, ?, ?, ?, ?)").bind(entry, gw, kind, status, iso(nowMs)).run();
}

export async function countPosts(db: BotDb, entry: string, gw: number, nowMs: number): Promise<{ gw: number; day: number }> {
  const dayStart = new Date(nowMs);
  dayStart.setUTCHours(0, 0, 0, 0);
  const g = await db.prepare("SELECT COUNT(*) AS n FROM bot_posts WHERE entry = ? AND gw = ?").bind(entry, gw).first<{ n: number }>();
  const d = await db.prepare("SELECT COUNT(*) AS n FROM bot_posts WHERE created_at >= ?").bind(dayStart.toISOString()).first<{ n: number }>();
  return { gw: Number(g?.n ?? 0), day: Number(d?.n ?? 0) };
}

// ------------------------------------------------------------------ decisions / errors log ---------------------

export async function insertDecision(db: BotDb, row: { entry: string | null; gw: number; step: string; mode: string; decisionHash: string | null; summary: unknown }, nowMs: number): Promise<void> {
  await db
    .prepare("INSERT INTO bot_decisions (entry, gw, step, mode, decision_hash, summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(row.entry, row.gw, row.step, row.mode, row.decisionHash, JSON.stringify(row.summary).slice(0, 8000), iso(nowMs))
    .run();
}

export type BotDecisionRow = { id: number; entry: string | null; gw: number; step: string; mode: string; decision_hash: string | null; summary_json: string; created_at: string };

export async function recentDecisions(db: BotDb, limit = 10): Promise<BotDecisionRow[]> {
  return (await db.prepare("SELECT * FROM bot_decisions ORDER BY id DESC LIMIT ?").bind(limit).all<BotDecisionRow>()).results ?? [];
}

export async function recordBotError(db: BotDb, code: string, detail: string | null, nowMs: number): Promise<void> {
  try {
    await db.prepare("INSERT INTO bot_errors (code, detail, created_at) VALUES (?, ?, ?)").bind(code.slice(0, 60), detail ? redact(detail, 300) : null, iso(nowMs)).run();
  } catch {
    // logging must never break the tick
  }
}

export type BotErrorRow = { id: number; code: string; detail: string | null; created_at: string };

export async function recentErrors(db: BotDb, limit = 10): Promise<BotErrorRow[]> {
  return (await db.prepare("SELECT * FROM bot_errors ORDER BY id DESC LIMIT ?").bind(limit).all<BotErrorRow>()).results ?? [];
}

/** Keep the logs bounded (called from the bot tick). */
export async function pruneBotLogs(db: BotDb, nowMs: number, keepDays = 120): Promise<void> {
  const cutoff = iso(nowMs - keepDays * 86_400_000);
  await db.prepare("DELETE FROM bot_decisions WHERE created_at < ?").bind(cutoff).run();
  await db.prepare("DELETE FROM bot_errors WHERE created_at < ?").bind(cutoff).run();
  await db.prepare("DELETE FROM bot_posts WHERE created_at < ?").bind(cutoff).run();
}
