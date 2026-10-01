/**
 * Resend transport for call alerts. Injectable (tests pass a fake), inert without secrets, and the only place
 * that knows the Resend HTTP API. Docs: POST https://api.resend.com/emails (Bearer key, JSON, Idempotency-Key header).
 *
 * The API key / from address are Worker SECRETS (RESEND_API_KEY, RESEND_FROM): never in the repo, never logged.
 */
export const RESEND_API_BASE = "https://api.resend.com";
const SEND_TIMEOUT_MS = 10_000;

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Deterministic per (user, call, day): a retry after a lost response cannot double-send (Resend dedupes for 24h). */
  idempotencyKey: string;
  /** Opt-out target: the account settings link (no per-user token in the URL). */
  settingsUrl: string;
};

export type SendResult =
  | { ok: true; id: string | null }
  | { ok: false; status: number; error: string; /** Stop the batch (provider rate limit / auth) rather than hammering. */ fatal: boolean };

export type MailTransport = (message: MailMessage) => Promise<SendResult>;

export type AlertEnv = {
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  /** Optional runtime override of the link host (e.g. after a custom domain is attached). */
  FPL_EDGE_SITE_URL?: string;
  /** DEV ONLY. See resolveResendBaseUrl. Never set in wrangler.jsonc. */
  FPL_EDGE_DEV_MODE?: string;
  FPL_EDGE_DEV_RESEND_BASE_URL?: string;
};

export type AlertConfig = { apiKey: string; from: string; baseUrl: string; siteUrl: string };

/**
 * A sender we control: a plain `name <local@domain>` or `local@domain`, never a *.workers.dev / *.pages.dev
 * address (those cannot be verified in Resend, mail would be rejected or spoofable).
 */
export function validSender(from: string | undefined): from is string {
  const value = (from ?? "").trim();
  const match = value.match(/^(?:[^<>@\r\n]*<)?([^\s<>@]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+))>?$/i);
  if (!match) return false;
  const domain = match[2].toLowerCase();
  return !/(^|\.)(workers|pages)\.dev$/.test(domain);
}

/**
 * The dev override lets e2e point the client at a local fake Resend. It is honoured ONLY when
 * FPL_EDGE_DEV_MODE === "1" AND the target is plain http on a loopback host. A production Worker has neither
 * variable, and even if someone set both, mail could only be redirected to localhost, never to a remote host.
 */
export function resolveResendBaseUrl(env: AlertEnv): string {
  if (env.FPL_EDGE_DEV_MODE === "1" && env.FPL_EDGE_DEV_RESEND_BASE_URL) {
    try {
      const url = new URL(env.FPL_EDGE_DEV_RESEND_BASE_URL);
      if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")) {
        return url.origin;
      }
    } catch {
      /* fall through to the real API */
    }
  }
  return RESEND_API_BASE;
}

export type ConfigResult = { ok: true; config: AlertConfig } | { ok: false; reason: "missing-secrets" | "invalid-from" };

export function readAlertConfig(env: AlertEnv, defaultSiteUrl: string): ConfigResult {
  const apiKey = (env.RESEND_API_KEY ?? "").trim();
  const from = (env.RESEND_FROM ?? "").trim();
  if (!apiKey || !from) return { ok: false, reason: "missing-secrets" };
  if (!validSender(from)) return { ok: false, reason: "invalid-from" };
  return { ok: true, config: { apiKey, from, baseUrl: resolveResendBaseUrl(env), siteUrl: (env.FPL_EDGE_SITE_URL ?? "").trim() || defaultSiteUrl } };
}

export function createResendTransport(config: Pick<AlertConfig, "apiKey" | "from" | "baseUrl">, fetchImpl: typeof fetch = fetch): MailTransport {
  return async (message) => {
    try {
      const response = await fetchImpl(`${config.baseUrl}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": message.idempotencyKey,
          "User-Agent": "FPL-Edge-alerts/1.0",
        },
        body: JSON.stringify({
          from: config.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          headers: { "List-Unsubscribe": `<${message.settingsUrl}>` },
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (response.ok) {
        const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
        return { ok: true, id: typeof body?.id === "string" ? body.id : null };
      }
      // Never echo the response body into logs verbatim: it can contain the recipient address.
      return { ok: false, status: response.status, error: `resend http ${response.status}`, fatal: response.status === 401 || response.status === 403 || response.status === 429 };
    } catch (error) {
      return { ok: false, status: 0, error: error instanceof Error ? error.name : "network-error", fatal: false };
    }
  };
}
