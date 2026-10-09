/**
 * Autonomous FPL bot: configuration, mode resolution and the "only ever the bot's own team" assertions.
 * Pure (no D1, no fetch). See docs/FPL-BOT.md.
 *
 * Separation rule: this module tree must never read a personal-account secret. The ONLY personal variable it reads
 * is FPL_EDGE_PERSONAL_FPL_ENTRY_ID, and only to prove the bot entry is a DIFFERENT team (tests enforce this).
 */

export const BOT_ENV = {
  mode: "FPL_EDGE_BOT_MODE",
  entryId: "FPL_EDGE_BOT_FPL_ENTRY_ID",
  refreshSeed: "FPL_EDGE_BOT_FPL_REFRESH_TOKEN",
  tokenKey: "FPL_EDGE_BOT_TOKEN_KEY",
  ownerEmails: "FPL_EDGE_BOT_OWNER_EMAILS",
  teamName: "FPL_EDGE_BOT_TEAM_NAME",
  hitPolicy: "FPL_EDGE_BOT_HIT_POLICY",
  chipPolicy: "FPL_EDGE_BOT_CHIP_POLICY",
} as const;

/** Read-only, used solely for the bot-entry != personal-entry assertion. */
export const PERSONAL_ENTRY_ENV_FOR_ASSERTION = "FPL_EDGE_PERSONAL_FPL_ENTRY_ID";

export type BotEnv = Readonly<Partial<Record<(typeof BOT_ENV)[keyof typeof BOT_ENV] | typeof PERSONAL_ENTRY_ENV_FOR_ASSERTION, string>>>;

export const BOT_MODES = ["off", "shadow", "live"] as const;
export type BotMode = (typeof BOT_MODES)[number];
const RANK: Record<BotMode, number> = { off: 0, shadow: 1, live: 2 };

export function parseMode(raw: string | null | undefined): BotMode | null {
  const value = (raw ?? "").trim().toLowerCase();
  return (BOT_MODES as readonly string[]).includes(value) ? (value as BotMode) : null;
}

export function minMode(a: BotMode, b: BotMode): BotMode {
  return RANK[a] <= RANK[b] ? a : b;
}

export function botEntryId(env: BotEnv): string | null {
  const id = env[BOT_ENV.entryId]?.trim() ?? "";
  return /^\d{1,12}$/.test(id) ? id : null;
}

function personalEntryId(env: BotEnv): string | null {
  const id = env[PERSONAL_ENTRY_ENV_FOR_ASSERTION]?.trim() ?? "";
  return /^\d{1,12}$/.test(id) ? id : null;
}

export class WrongEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrongEntryError";
  }
}

/**
 * Returns the bot entry id or throws. Every FPL URL / request body the bot builds goes through this, so the bot can
 * never address any other team (in particular the owner's personal team).
 */
export function assertBotEntry(env: BotEnv, candidate?: string | number | null): string {
  const bot = botEntryId(env);
  if (!bot) throw new WrongEntryError("bot entry id is not configured");
  const personal = personalEntryId(env);
  if (personal && personal === bot) throw new WrongEntryError("bot entry id equals the personal entry id");
  if (candidate !== undefined && candidate !== null && String(candidate) !== bot) {
    throw new WrongEntryError("entry does not match the configured bot entry");
  }
  return bot;
}

export function isBotEntrySameAsPersonal(env: BotEnv): boolean {
  const bot = botEntryId(env);
  const personal = personalEntryId(env);
  return Boolean(bot && personal && bot === personal);
}

export function botOwnerEmails(env: BotEnv): readonly string[] {
  return (env[BOT_ENV.ownerEmails] ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function isBotOwner(env: BotEnv, email: string | null | undefined): boolean {
  const normalized = (email ?? "").trim().toLowerCase();
  return Boolean(normalized) && botOwnerEmails(env).includes(normalized);
}

// ------------------------------------------------------------------ policies -----------------------------------

export type HitPolicy = Readonly<{
  /** Max paid transfers (each -4) in one gameweek. 0 disables hits. */
  maxHitsPerGw: number;
  /** Max hit points over the rolling 4 gameweeks (incl. this one). */
  maxHitPointsRolling4: number;
  /** Extra NET (pts over 5 GWs, risk-adjusted, vs HOLD) required ON TOP of the engine's hit MAKE threshold. */
  safetyMargin: number;
}>;

/** Default: at most one -4, only when the engine's risk-adjusted 5-GW net vs HOLD clears MAKE (4.0) + 1.0. */
export const DEFAULT_HIT_POLICY: HitPolicy = Object.freeze({ maxHitsPerGw: 1, maxHitPointsRolling4: 8, safetyMargin: 1.0 });

/** FPL_EDGE_BOT_HIT_POLICY: "none" | "default" | "max<N>" e.g. "max1" (N in 0..2). Unknown => default. */
export function parseHitPolicy(raw: string | null | undefined): HitPolicy {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "none" || value === "0" || value === "max0") return { ...DEFAULT_HIT_POLICY, maxHitsPerGw: 0, maxHitPointsRolling4: 0 };
  const match = /^max([12])$/.exec(value);
  if (match) {
    const n = Number(match[1]);
    return { ...DEFAULT_HIT_POLICY, maxHitsPerGw: n, maxHitPointsRolling4: Math.max(8, n * 4) };
  }
  return DEFAULT_HIT_POLICY;
}

/** Which chips the bot may play by itself. "all" (default: full control), "cancellable" (BB/TC only), "none". */
export type ChipPolicy = "all" | "cancellable" | "none";
export function parseChipPolicy(raw: string | null | undefined): ChipPolicy {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "none" || value === "cancellable" ? value : "all";
}

// ------------------------------------------------------------------ mode resolution ---------------------------

export type ModeInputs = Readonly<{
  env: BotEnv;
  /** bot_state.mode (null = follow env). */
  storedMode: string | null;
  kill: boolean;
  /** Bot token connected and identity (GET /api/me entry == bot entry) verified. */
  identityVerified: boolean;
  /** A shadow dry run passed for the CURRENT bot entry. */
  dryRunPassed: boolean;
}>;

export type ModeResolution = Readonly<{
  requested: BotMode;
  effective: BotMode;
  /** Why effective < requested (empty when equal). */
  reasons: readonly string[];
}>;

/**
 * Requested mode = bot_state.mode when the owner set one on the status page, else FPL_EDGE_BOT_MODE, else "shadow".
 * FPL_EDGE_BOT_MODE=off is a hard ops kill that the page cannot override. Live additionally needs: bot entry configured
 * (and != personal), token identity verified, and a passed dry run for that entry. Anything missing => shadow.
 */
export function resolveMode(inputs: ModeInputs): ModeResolution {
  const envMode = parseMode(inputs.env[BOT_ENV.mode]);
  const stored = parseMode(inputs.storedMode);
  const requested: BotMode = envMode === "off" ? "off" : stored ?? envMode ?? "shadow";
  const reasons: string[] = [];
  let effective: BotMode = requested;
  if (inputs.kill) {
    reasons.push("kill-switch");
    effective = "off";
  }
  if (!botEntryId(inputs.env)) {
    if (effective !== "off") reasons.push("no-bot-entry");
    effective = minMode(effective, "shadow");
  }
  if (isBotEntrySameAsPersonal(inputs.env)) {
    reasons.push("bot-entry-equals-personal");
    effective = "off";
  }
  if (effective === "live" && !inputs.identityVerified) {
    reasons.push("identity-unverified");
    effective = "shadow";
  }
  if (effective === "live" && !inputs.dryRunPassed) {
    reasons.push("dry-run-not-passed");
    effective = "shadow";
  }
  return { requested, effective, reasons };
}

// ------------------------------------------------------------------ hard caps ---------------------------------

export const BOT_LIMITS = Object.freeze({
  /** Authenticated FPL calls per tick (GET + POST). */
  maxAuthedCallsPerRun: 12,
  /** All outbound requests per tick (incl. public GETs). */
  maxSubrequestsPerRun: 60,
  maxPostsPerGw: 4,
  maxPostsPerUtcDay: 6,
  /** Minimum spacing between authenticated calls. */
  authedSpacingMs: 1500,
  authedJitterMs: 500,
  /** Never POST closer than this to the deadline. */
  deadlineGuardMs: 5 * 60_000,
  /** Global job lock lease. */
  lockLeaseMs: 10 * 60_000,
  /** Per-step claim lease. */
  stepLeaseMs: 120_000,
  /** Session (PingOne absolute ~30 days) warning thresholds. */
  sessionWarnDays: 20,
  sessionStopMultiStepDays: 28,
  /** Re-verify /api/me at least this often. */
  identityMaxAgeMs: 24 * 3_600_000,
});
