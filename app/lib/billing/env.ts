// Dynamic import for the same reason as db/index.ts's getDb: this bundles into the single worker
// entry that fronts every route, so a static "cloudflare:workers" import here would force any
// route that never touches billing to resolve it too.
export async function getStripeEnv(): Promise<{ secretKey: string; webhookSecret: string; priceId: string }> {
  const { env } = await import("cloudflare:workers");
  const { STRIPE_SECRET_KEY: secretKey, STRIPE_WEBHOOK_SECRET: webhookSecret, STRIPE_SEASON_PRICE_ID: priceId } = env;
  if (!secretKey || !webhookSecret || !priceId) {
    throw new Error(
      "Stripe is not configured. Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_SEASON_PRICE_ID (wrangler secret put) before using billing routes."
    );
  }
  return { secretKey, webhookSecret, priceId };
}
