// Personal-only FPL transfer execution. Kill switch + allowlist.
// Default OFF for everyone. Delete this folder (and the /api/personal/fpl-transfer routes)
// to remove the path without touching the recommender.

export const PERSONAL_TRANSFER_EXEC_ENV = "FPL_EDGE_PERSONAL_TRANSFER_EXEC";
export const PERSONAL_TRANSFER_ALLOWLIST_ENV = "FPL_EDGE_PERSONAL_TRANSFER_ALLOWLIST";
export const PERSONAL_FPL_ENTRY_ID_ENV = "FPL_EDGE_PERSONAL_FPL_ENTRY_ID";
export const PERSONAL_FPL_REFRESH_TOKEN_ENV = "FPL_EDGE_PERSONAL_FPL_REFRESH_TOKEN";

export type PersonalTransferEnv = Readonly<{
  [PERSONAL_TRANSFER_EXEC_ENV]?: string;
  [PERSONAL_TRANSFER_ALLOWLIST_ENV]?: string;
  [PERSONAL_FPL_ENTRY_ID_ENV]?: string;
  [PERSONAL_FPL_REFRESH_TOKEN_ENV]?: string;
}>;

export function isPersonalTransferExecEnabled(env: PersonalTransferEnv): boolean {
  return env[PERSONAL_TRANSFER_EXEC_ENV] === "1";
}

export function personalTransferAllowlist(env: PersonalTransferEnv): readonly string[] {
  const raw = env[PERSONAL_TRANSFER_ALLOWLIST_ENV] ?? "";
  return raw
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isEmailAllowlisted(email: string, env: PersonalTransferEnv): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return personalTransferAllowlist(env).includes(normalized);
}

export function personalFplEntryId(env: PersonalTransferEnv): string | null {
  const id = env[PERSONAL_FPL_ENTRY_ID_ENV]?.trim() ?? "";
  return /^\d+$/.test(id) ? id : null;
}

/** Worker secrets are capped at 5 KB — whole oidc.user JSON often exceeds that and truncates. */
export const WORKER_SECRET_MAX_BYTES = 5 * 1024;
/** Bare PingOne refresh tokens fit under this; larger blobs are almost always truncated JSON. */
export const MAX_BARE_REFRESH_TOKEN_CHARS = 2048;
export const MIN_REFRESH_TOKEN_CHARS = 8;

function looksLikeJsonBlob(value: string): boolean {
  const t = value.trim();
  return t.startsWith("{") || t.includes("access_token") || t.includes("oidc.user") || t.includes("id_token");
}

function isPlausibleRefreshToken(token: string): boolean {
  if (token.length < MIN_REFRESH_TOKEN_CHARS) return false;
  if (token.length > MAX_BARE_REFRESH_TOKEN_CHARS) return false;
  if (looksLikeJsonBlob(token)) return false;
  if (/[\u0000-\u001f]/.test(token)) return false;
  return true;
}

/**
 * Extract ONLY refresh_token. Never persist whole oidc.user JSON — Worker secrets
 * truncate near 5 KB and truncated JSON becomes invalid_grant.
 * Returns null when input is missing, truncated, or not a plausible token.
 */
export function extractRefreshToken(pasted: string): string | null {
  const trimmed = pasted.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as { refresh_token?: unknown };
    if (parsed && typeof parsed.refresh_token === "string") {
      const token = parsed.refresh_token.trim();
      return isPlausibleRefreshToken(token) ? token : null;
    }
  } catch {
    // Truncated / bare token path below.
  }

  // Truncated oidc.user JSON: pull a complete "refresh_token":"..." value if present.
  const field = trimmed.match(/"refresh_token"\s*:\s*"([^"]+)"/);
  if (field?.[1]) {
    const token = field[1].trim();
    return isPlausibleRefreshToken(token) ? token : null;
  }

  if (looksLikeJsonBlob(trimmed)) return null;
  return isPlausibleRefreshToken(trimmed) ? trimmed : null;
}

/** Back-compat: returns "" when extraction fails (callers treat short/empty as missing). */
export function parseRefreshTokenInput(pasted: string): string {
  return extractRefreshToken(pasted) ?? "";
}

export type PersonalTransferGate =
  | { ok: true; entryId: string }
  | { ok: false; reason: "disabled" | "not-allowlisted" | "missing-entry" | "unauthenticated" };

export function evaluatePersonalTransferGate(
  env: PersonalTransferEnv,
  userEmail: string | null,
): PersonalTransferGate {
  if (!isPersonalTransferExecEnabled(env)) return { ok: false, reason: "disabled" };
  if (!userEmail) return { ok: false, reason: "unauthenticated" };
  if (!isEmailAllowlisted(userEmail, env)) return { ok: false, reason: "not-allowlisted" };
  const entryId = personalFplEntryId(env);
  if (!entryId) return { ok: false, reason: "missing-entry" };
  return { ok: true, entryId };
}

/** Gate for reconnect / health — allowlisted + entry, without EXEC kill switch. */
export type PersonalAuthManageGate =
  | { ok: true; entryId: string }
  | { ok: false; reason: "not-allowlisted" | "missing-entry" | "unauthenticated" };

export function evaluatePersonalAuthManageGate(
  env: PersonalTransferEnv,
  userEmail: string | null,
): PersonalAuthManageGate {
  if (!userEmail) return { ok: false, reason: "unauthenticated" };
  if (!isEmailAllowlisted(userEmail, env)) return { ok: false, reason: "not-allowlisted" };
  const entryId = personalFplEntryId(env);
  if (!entryId) return { ok: false, reason: "missing-entry" };
  return { ok: true, entryId };
}
