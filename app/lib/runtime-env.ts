// Worker secrets live on the Cloudflare env binding. process.env covers local Node and tests.
// A missing cloudflare:workers module (plain Node) is expected — do not treat that as configured.

const ENV_KEYS = [
  "NODE_ENV",
  "PAYMOB_SECRET_KEY",
  "PAYMOB_PUBLIC_KEY",
  "PAYMOB_HMAC_SECRET",
  "PAYMOB_INTEGRATION_ID",
  "PAYMOB_BASE_URL",
  "FPL_EDGE_DEV_SEASON_GRANT",
  "FPL_EDGE_PERSONAL_TRANSFER_EXEC",
  "FPL_EDGE_PERSONAL_TRANSFER_ALLOWLIST",
  "FPL_EDGE_PERSONAL_FPL_ENTRY_ID",
  "FPL_EDGE_PERSONAL_FPL_REFRESH_TOKEN",
  // Autonomous bot (app/lib/fpl-bot). The refresh-token seed is deliberately NOT exposed to routes.
  "FPL_EDGE_BOT_MODE",
  "FPL_EDGE_BOT_FPL_ENTRY_ID",
  "FPL_EDGE_BOT_TOKEN_KEY",
  "FPL_EDGE_BOT_OWNER_EMAILS",
  "FPL_EDGE_BOT_TEAM_NAME",
  "FPL_EDGE_BOT_HIT_POLICY",
  "FPL_EDGE_BOT_CHIP_POLICY",
] as const;

export async function readRuntimeEnv(): Promise<Record<string, string | undefined>> {
  const values: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) values[key] = process.env[key];
  try {
    const { env } = await import("cloudflare:workers");
    const record = env as unknown as Record<string, unknown>;
    for (const key of ENV_KEYS) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) values[key] = value;
    }
  } catch {
    // Not inside the Workers runtime.
  }
  return values;
}
