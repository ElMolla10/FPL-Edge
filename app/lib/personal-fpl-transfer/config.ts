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

export function parseRefreshTokenInput(pasted: string): string {
  const trimmed = pasted.trim();
  try {
    const parsed = JSON.parse(trimmed) as { refresh_token?: unknown };
    if (parsed && typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0) {
      return parsed.refresh_token;
    }
  } catch {
    // Bare token.
  }
  return trimmed;
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
