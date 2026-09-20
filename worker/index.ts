/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { keepAlivePersonalFplAuth } from "../app/lib/personal-fpl-transfer/keep-alive";

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

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },

  /**
   * Keep the personal FPL refresh token alive even when nobody opens Transfers.
   * Uses the same CAS/access-token cache as live overlay — never race-rotates.
   * On token-expired: leave overlay unavailable (no invented bank).
   * Schedule: every 4 hours (see wrangler.jsonc triggers.crons).
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
  },
};

export default worker;
