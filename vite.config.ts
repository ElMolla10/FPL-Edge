import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

// A real, personal `vinext deploy` (outside the Sites platform -- e.g. to the developer's own
// Cloudflare account) generates a real wrangler.jsonc with its own real D1/R2 bindings. The Sites
// platform's own remote builder never reads wrangler.jsonc at all (confirmed in README.SITES.md:
// "This starter does not use wrangler.jsonc" -- it gets real bindings from .openai/hosting.json
// via its own external deploy mechanism), so this placeholder injection below only ever matters
// for a personal deploy path, and must defer to a real binding of the same name if one already
// exists there -- otherwise wrangler rejects the build with a duplicate-binding-name error, which
// is exactly what happened before this fix.
const wranglerConfigPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "wrangler.jsonc",
);
function existingBindingNames(key: "d1_databases" | "r2_buckets"): Set<string> {
  if (!existsSync(wranglerConfigPath)) return new Set();
  try {
    const raw = readFileSync(wranglerConfigPath, "utf8");
    const withoutComments = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const parsed = JSON.parse(withoutComments);
    const entries = Array.isArray(parsed[key]) ? parsed[key] : [];
    return new Set(entries.map((entry: { binding?: string }) => entry.binding).filter(Boolean));
  } catch {
    return new Set();
  }
}
const existingD1Bindings = existingBindingNames("d1_databases");
const existingR2Bindings = existingBindingNames("r2_buckets");

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases:
    d1 && !existingD1Bindings.has(d1)
      ? [
          {
            binding: d1,
            database_name: "site-creator-d1",
            database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
          },
        ]
      : [],
  r2_buckets:
    r2 && !existingR2Bindings.has(r2)
      ? [
          {
            binding: r2,
            bucket_name: "site-creator-r2",
          },
        ]
      : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      host: "0.0.0.0",
      allowedHosts: ["terminal.local"],
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config: localBindingConfig,
      }),
    ],
  };
});
