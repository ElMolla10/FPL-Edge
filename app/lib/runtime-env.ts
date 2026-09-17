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
