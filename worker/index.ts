/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { keepAlivePersonalFplAuth } from "../app/lib/personal-fpl-transfer/keep-alive";
import { pruneExpiredData } from "../app/lib/maintenance";
import { prepareSecurity } from "../app/lib/security-headers";
import { inspectBot, rehearseBot, runBotTick, type TickDeps } from "../app/lib/fpl-bot/runner";
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
  /** Optional: enables POST /__bot/run (operator trigger). Unset => the path 404s. */
  FPL_EDGE_BOT_TRIGGER_SECRET?: string;
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

/** Same dependencies the cron uses: official data via the app's own /api/fpl route in-process, public GETs direct. */
function botDeps(env: Env, ctx: ExecutionContext): TickDeps {
  return {
    env,
    db: env.DB,
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
  };
}

async function sameSecret(provided: string, expected: string): Promise<boolean> {
  const digest = async (v: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
  const [a, b] = await Promise.all([digest(provided), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Operator trigger for the bot (POST /__bot/run, Authorization: Bearer <FPL_EDGE_BOT_TRIGGER_SECRET>):
 *   inspect  - read-only my-team shape + pre-first-deadline detection
 *   rehearse - read-only full plan + payloads + validation against live data
 *   tick     - exactly the hourly cron tick (same lock, mode resolution, kill switch, caps, validation, verification)
 * Disabled (404) unless the secret is set (>= 32 chars). Nothing here bypasses a cron safety rail.
 */
async function botTrigger(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const secret = env.FPL_EDGE_BOT_TRIGGER_SECRET ?? "";
  const notFound = () => new Response("Not found", { status: 404 });
  if (secret.length < 32 || request.method !== "POST") return notFound();
  const auth = request.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!provided || !(await sameSecret(provided, secret))) return notFound();
  let action = "";
  let body: { action?: unknown; event?: unknown; simulateFreeTransfers?: unknown } = {};
  try {
    body = ((await request.json()) as typeof body) ?? {};
    action = String(body.action ?? "");
  } catch {
    action = "";
  }
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  try {
    const deps = botDeps(env, ctx);
    if (action === "inspect") return json(await inspectBot(deps));
    if (action === "rehearse") {
      const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : undefined);
      return json(await rehearseBot(deps, { event: num(body.event), simulateFreeTransfers: num(body.simulateFreeTransfers) }));
    }
    if (action === "tick") return json(await runBotTick(deps));
    return json({ ok: false, error: "unknown-action" }, 400);
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "error" }, 500);
  }
}

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

    if (url.pathname === "/__bot/run") return security.finalize(await botTrigger(request, env, ctx));

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
   *      can ever write to FPL (plus the secret-gated operator trigger /__bot/run, which runs this SAME tick). Mode
   *      off|shadow|live, default shadow.
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
          const summary = await runBotTick(botDeps(env, ctx));
          console.warn(`[fpl-bot] tick ran=${summary.ran} mode=${summary.mode?.effective ?? "-"} window=${summary.window ?? "-"} gw=${summary.gw ?? "-"} auth=${summary.auth} actions=${summary.actions.length} errors=${summary.errors.join(",") || "none"} cron=${controller.cron}`);
        } catch (error) {
          console.warn(`[fpl-bot] failed ${error instanceof Error ? error.name : "error"} cron=${controller.cron}`);
        }
      })(),
    );
  },
};

export default worker;
