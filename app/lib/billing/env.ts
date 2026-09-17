// Dynamic import for the same reason as db/index.ts's getDb: this bundles into the single worker
// entry that fronts every route, so a static "cloudflare:workers" import here would force any
// route that never touches billing to resolve it too.
export async function getPaymobEnv(): Promise<{ apiKey: string; integrationId: string; hmacSecret: string; iframeId: string }> {
  const { env } = await import("cloudflare:workers");
  const { PAYMOB_API_KEY: apiKey, PAYMOB_INTEGRATION_ID: integrationId, PAYMOB_HMAC_SECRET: hmacSecret, PAYMOB_IFRAME_ID: iframeId } = env;
  if (!apiKey || !integrationId || !hmacSecret || !iframeId) {
    throw new Error(
      "Paymob is not configured. Set PAYMOB_API_KEY, PAYMOB_INTEGRATION_ID, PAYMOB_HMAC_SECRET, and PAYMOB_IFRAME_ID (wrangler secret put) before using billing routes."
    );
  }
  return { apiKey, integrationId, hmacSecret, iframeId };
}

// Separate from getPaymobEnv() because this is a real business number (the actual season price),
// not a credential -- callers that only need the price (none yet) shouldn't have to also satisfy
// the credential checks, and vice versa.
export async function getSeasonPriceEgpCents(): Promise<number> {
  const { env } = await import("cloudflare:workers");
  const raw = env.PAYMOB_SEASON_PRICE_EGP_CENTS;
  const cents = raw ? Number(raw) : NaN;
  if (!Number.isFinite(cents) || cents <= 0) {
    throw new Error("PAYMOB_SEASON_PRICE_EGP_CENTS is not set to a real price. Set it (wrangler secret put) before using billing routes.");
  }
  return cents;
}
