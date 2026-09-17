// Paymob Accept Intention API (Egypt). Credentials are read from the environment — never
// hardcoded. Required:
//   PAYMOB_SECRET_KEY       Authorization: Token <secret> for POST /v1/intention/
//   PAYMOB_PUBLIC_KEY       Unified Checkout public key (safe to expose on the redirect URL)
//   PAYMOB_HMAC_SECRET      HMAC secret from Dashboard → Settings → API Keys
//   PAYMOB_INTEGRATION_ID   Integer integration id (card integration, so notification_url is sent)
// Optional:
//   PAYMOB_BASE_URL         Defaults to https://accept.paymob.com
// Access is never granted here. The caller stores intention_order_id and waits for the
// verified Transaction Processed callback (see grantSeasonAccessFromCallback).

import { SEASON_PASS_PRICE_PIASTERS } from "./season-pass";

export const DEFAULT_PAYMOB_BASE_URL = "https://accept.paymob.com";

export type PaymobConfig = {
  secretKey: string;
  publicKey: string;
  hmacSecret: string;
  integrationId: number;
  baseUrl: string;
};

export function paymobConfigFromEnv(env: { [key: string]: string | undefined }): PaymobConfig | null {
  const secretKey = env.PAYMOB_SECRET_KEY?.trim() ?? "";
  const publicKey = env.PAYMOB_PUBLIC_KEY?.trim() ?? "";
  const hmacSecret = env.PAYMOB_HMAC_SECRET?.trim() ?? "";
  const integrationRaw = env.PAYMOB_INTEGRATION_ID?.trim() ?? "";
  const integrationId = Number(integrationRaw);
  if (!secretKey || !publicKey || !hmacSecret || !integrationRaw || !Number.isInteger(integrationId) || integrationId <= 0) return null;
  const baseUrl = (env.PAYMOB_BASE_URL?.trim() || DEFAULT_PAYMOB_BASE_URL).replace(/\/$/, "");
  return { secretKey, publicKey, hmacSecret, integrationId, baseUrl };
}

export function unifiedCheckoutUrl(baseUrl: string, publicKey: string, clientSecret: string): string {
  const url = new URL("/unifiedcheckout/", `${baseUrl}/`);
  url.searchParams.set("publicKey", publicKey);
  url.searchParams.set("clientSecret", clientSecret);
  return url.toString();
}

function billingFirstName(email: string): string {
  const local = email.split("@")[0]?.replace(/[^A-Za-z]/g, "") ?? "";
  return (local.slice(0, 20) || "Fpl");
}

export type PaymobIntention = {
  intentionId: string;
  orderId: string;
  clientSecret: string;
  checkoutUrl: string;
};

export async function createPaymobIntention(
  config: PaymobConfig,
  input: { specialReference: string; email: string; phone: string; notificationUrl: string; redirectionUrl: string },
  fetchImpl: typeof fetch = fetch,
): Promise<PaymobIntention> {
  const response = await fetchImpl(`${config.baseUrl}/v1/intention/`, {
    method: "POST",
    headers: {
      Authorization: `Token ${config.secretKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      amount: SEASON_PASS_PRICE_PIASTERS,
      currency: "EGP",
      payment_methods: [config.integrationId],
      items: [{
        name: "FPL Edge season pass",
        amount: SEASON_PASS_PRICE_PIASTERS,
        description: "Full decision desk for the rest of the current FPL season",
        quantity: 1,
      }],
      billing_data: {
        first_name: billingFirstName(input.email),
        last_name: "Fan",
        phone_number: input.phone,
        email: input.email,
        street: "NA",
        building: "NA",
        floor: "NA",
        apartment: "NA",
        city: "Cairo",
        country: "EGY",
        state: "Cairo",
      },
      special_reference: input.specialReference,
      notification_url: input.notificationUrl,
      redirection_url: input.redirectionUrl,
    }),
  });
  const json = (await response.json().catch(() => null)) as {
    id?: unknown;
    intention_order_id?: unknown;
    client_secret?: unknown;
  } | null;
  if (!response.ok || !json) {
    throw new Error(`Paymob intention failed (${response.status}).`);
  }
  if (json.id === undefined || json.id === null || json.intention_order_id === undefined || json.intention_order_id === null || typeof json.client_secret !== "string" || !json.client_secret) {
    throw new Error("Paymob intention response was missing client_secret or order id.");
  }
  return {
    intentionId: String(json.id),
    orderId: String(json.intention_order_id),
    clientSecret: json.client_secret,
    checkoutUrl: unifiedCheckoutUrl(config.baseUrl, config.publicKey, json.client_secret),
  };
}
