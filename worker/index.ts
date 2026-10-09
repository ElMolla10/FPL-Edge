/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { keepAlivePersonalFplAuth } from "../app/lib/personal-fpl-transfer/keep-alive";
import { pruneExpiredData } from "../app/lib/maintenance";
import { prepareSecurity } from "../app/lib/security-headers";
import { runBotTick } from "../app/lib/fpl-bot/runner";
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
  /** Autonomous bot (app/lib/fpl-bot, docs/FPL-BOT.md). Worker SECRETS/vars; never committed. Inert without an entry id. */
  FPL_EDGE_BOT_MODE?: string;
  FPL_EDGE_BOT_FPL_ENTRY_ID?: string;
  FPL_EDGE_BOT_FPL_REFRESH_TOKEN?: string;
  FPL_EDGE_BOT_TOKEN_KEY?: string;
  FPL_EDGE_BOT_OWNER_EMAILS?: string;
  FPL_EDGE_BOT_TEAM_NAME?: string;
  FPL_EDGE_BOT_HIT_POLICY?: string;
  FPL_EDGE_BOT_CHIP_POLICY?: string;
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
   * Cron entry (hourly, wrangler.jsonc triggers.crons "0 * * * *"). Independent jobs, each in its own
   * waitUntil so one failing never blocks the others:
   *   1. personal FPL refresh-token keep-alive (unchanged, below)
   *   2. prune expired sessions + stale rate-limit rows (app/lib/maintenance.ts)
   *   3. autonomous bot tick (app/lib/fpl-bot/runner.ts): its OWN token store + team only; the only place the bot
   *      can ever write to FPL (no HTTP route can trigger a submission). Mode off|shadow|live, default shadow.
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
          const summary = await runBotTick({
            env,
            db: env.DB,
            // Same official snapshot the site serves, via the app's own /api/fpl route in-process (no parallel data path).
            loadData: async () => {
              const response = await handler.fetch(new Request("https://fpl-edge.internal/api/fpl", { headers: { Accept: "application/json" } }), env, ctx);
              if (!response.ok) throw new Error(`api/fpl ${response.status}`);
              return (await response.json()) as FplData;
            },
            fetchPublicJson: async (target) => {
              const response = await fetch(target, { headers: { Accept: "application/json", "User-Agent": "FPL-Edge-Bot/1.0 (automated, owner-operated)" }, cache: "no-store" });
              if (!response.ok) throw new Error(`public ${response.status}`);
              return response.json();
            },
          });
          console.warn(`[fpl-bot] tick ran=${summary.ran} mode=${summary.mode?.effective ?? "-"} window=${summary.window ?? "-"} gw=${summary.gw ?? "-"} auth=${summary.auth} actions=${summary.actions.length} errors=${summary.errors.join(",") || "none"} cron=${controller.cron}`);
        } catch (error) {
          console.warn(`[fpl-bot] failed ${error instanceof Error ? error.name : "error"} cron=${controller.cron}`);
        }
      })(),
    );
  },
};

export default worker;
