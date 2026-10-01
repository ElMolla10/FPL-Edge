/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { keepAlivePersonalFplAuth } from "../app/lib/personal-fpl-transfer/keep-alive";
import { pruneExpiredData } from "../app/lib/maintenance";
import { prepareSecurity } from "../app/lib/security-headers";
import { runCallAlerts } from "../app/lib/call-alerts/run";
import { createTeamLoader } from "../app/lib/call-alerts/fpl-team";
import type { FplData } from "../app/lib/fpl";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
  FPL_EDGE_PERSONAL_TRANSFER_EXEC?: string;
  FPL_EDGE_PERSONAL_TRANSFER_ALLOWLIST?: string;
  FPL_EDGE_PERSONAL_FPL_ENTRY_ID?: string;
  FPL_EDGE_PERSONAL_FPL_REFRESH_TOKEN?: string;
  /** Optional runtime kill switch: "report-only" downgrades the enforcing CSP to Content-Security-Policy-Report-Only. */
  FPL_EDGE_CSP_MODE?: string;
  /** Email call alerts (Worker SECRETS, set with `wrangler secret put`; never committed). Feature is inert without both. */
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  /** Optional link host for alert emails (default: the production workers.dev host). */
  FPL_EDGE_SITE_URL?: string;
  /** DEV ONLY (.dev.vars / wrangler dev): honoured only with a loopback http URL. Never set in wrangler.jsonc. */
  FPL_EDGE_DEV_MODE?: string;
  FPL_EDGE_DEV_RESEND_BASE_URL?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Security headers (CSP + friends) are applied HERE, not in next.config.ts: vinext does not run
    // next.config headers() for every response (e.g. "/" is served without them; verified, see
    // docs/SECURITY.md). Every response path below goes through `security.finalize`.
    const security = prepareSecurity(request, { cspMode: env.FPL_EDGE_CSP_MODE });

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return security.finalize(await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths));
    }

    // Defense in depth: never trust client-supplied oai-* identity headers on Workers.
    // On OpenAI Sites these were platform-injected; here any client can spoof them.
    const clean = new Headers(request.headers);
    for (const key of [...clean.keys()]) if (key.startsWith("oai-")) clean.delete(key);
    // Hand the per-request CSP nonce to vinext/layout via the (server-side only) request header.
    // Any client-supplied content-security-policy request header is overwritten here.
    security.applyToRequestHeaders(clean);
    return security.finalize(await handler.fetch(new Request(request, { headers: clean }), env, ctx));
  },

  /**
   * Cron entry (hourly, wrangler.jsonc triggers.crons "0 * * * *"). Three independent jobs, each in its own
   * waitUntil so one failing never blocks the others:
   *   1. personal FPL refresh-token keep-alive (unchanged, below)
   *   2. prune expired sessions + stale rate-limit rows (app/lib/maintenance.ts)
   *   3. email call alerts for opted-in users (app/lib/call-alerts; inert without RESEND_* secrets)
   *
   * Keep the personal FPL refresh token alive even when nobody opens Transfers.
   * Uses the same CAS/access-token cache as live overlay — never race-rotates.
   * On token-expired: leave overlay unavailable (no invented bank).
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const result = await keepAlivePersonalFplAuth(env);
        if (result.ok) {
          console.warn(`[fpl-token-keepalive] ok refreshed=${result.refreshed} cron=${controller.cron}`);
        } else {
          console.warn(`[fpl-token-keepalive] ${result.reason} cron=${controller.cron}`);
        }
      })(),
    );
    ctx.waitUntil(
      (async () => {
        try {
          const pruned = await pruneExpiredData(env.DB);
          console.warn(`[prune] sessions=${pruned.sessionsDeleted} rateLimits=${pruned.rateLimitsDeleted} cron=${controller.cron}`);
        } catch (error) {
          console.warn(`[prune] failed ${error instanceof Error ? error.message : "error"} cron=${controller.cron}`);
        }
      })(),
    );
    ctx.waitUntil(
      (async () => {
        try {
          await runCallAlerts(env, {
            db: env.DB,
            // The same official snapshot the site serves (bootstrap + fixtures + live-event cache), obtained by
            // running the app's own /api/fpl route in-process: one load per run, no parallel data path.
            loadData: async () => {
              const response = await handler.fetch(new Request("https://fpl-edge.internal/api/fpl", { headers: { Accept: "application/json" } }), env, ctx);
              if (!response.ok) throw new Error(`api/fpl ${response.status}`);
              return (await response.json()) as FplData;
            },
            makeTeamLoader: (data) => createTeamLoader(data, env),
          });
        } catch (error) {
          console.warn(`[call-alerts] failed ${error instanceof Error ? error.name : "error"} cron=${controller.cron}`);
        }
      })(),
    );
  },
};

export default worker;
