// Paymob's Accept flow is a multi-step dance (auth -> order registration -> payment key ->
// iframe), not a single hosted-checkout-session call like Stripe's -- but the route calling this
// gateway doesn't need to know that; createCheckoutSession hides all of it behind the same
// {id, url}-shaped contract the Stripe version had. What genuinely can't be preserved as-is is
// webhook verification: Paymob signs a specific ORDERED CONCATENATION of extracted transaction
// fields (not the raw body) and sends the result as a `?hmac=` query parameter (not a header), so
// verifyAndParseCallback needs the parsed body and the query param, not a raw-body/signature pair.
//
// Base URL note: uses the current accept.paymob.com host. Some older SDKs still reference
// accept.paymobsolutions.com (Paymob's pre-rebrand domain) -- confirm this is still correct before
// going live, alongside the other "verify before going live" items in HANDOFF.md.
import { timingSafeEqual } from "../auth-core";

const BASE_URL = "https://accept.paymob.com";

export type PaymobCheckoutResult = { orderId: string; url: string };

export type PaymobTransaction = {
  orderId: string;
  success: boolean;
  pending: boolean;
  isRefunded: boolean;
  isVoided: boolean;
};

export type PaymobGateway = {
  createCheckoutSession(params: {
    amountCents: number;
    merchantOrderId: string;
    billingEmail: string;
    billingName: string;
    // Accepted for interface stability with the previous (Stripe) shape, but NOT currently sent
    // to Paymob -- the working assumption (per Paymob's own "before you begin" integration
    // checklist listing success/failure redirect URLs as an upfront requirement, not a per-request
    // API field) is that the post-payment redirect is configured once per Integration in the
    // Paymob dashboard, not passed dynamically here. This has NOT been confirmed against the
    // payment-key API reference's exact accepted-fields list. Confirm this, or configure the
    // dashboard's redirect URLs to point at these same paths directly, before relying on it --
    // this doesn't affect security or entitlement (only the POST server-to-server callback below
    // ever grants/revokes access), only where the user's browser lands after paying.
    successUrl: string;
    cancelUrl: string;
  }): Promise<PaymobCheckoutResult>;
  // Returns null if the signature doesn't verify -- callers must treat that as untrusted input,
  // never partially act on the parsed transaction.
  verifyAndParseCallback(rawBody: string, hmacFromQuery: string | null): Promise<PaymobTransaction | null>;
};

// The 20 field names the HMAC covers, straight from Paymob's own callback field list -- declared
// in ANY order here (this is NOT the order used in the actual calculation). Paymob's real rule is
// "these fields, sorted lexicographically," not a memorized sequence -- sorting programmatically
// below is what actually enforces the order, so this array being pre-sorted or not is irrelevant.
const HMAC_FIELDS = [
  "amount_cents",
  "created_at",
  "currency",
  "error_occured",
  "has_parent_transaction",
  "id",
  "integration_id",
  "is_3d_secure",
  "is_auth",
  "is_capture",
  "is_refunded",
  "is_standalone_payment",
  "is_voided",
  "order.id",
  "owner",
  "pending",
  "source_data.pan",
  "source_data.sub_type",
  "source_data.type",
  "success",
];

function fieldValue(transaction: Record<string, unknown>, dottedPath: string): string {
  const value = dottedPath.split(".").reduce<unknown>((node, key) => {
    if (node == null || typeof node !== "object") return undefined;
    return (node as Record<string, unknown>)[key];
  }, transaction);
  return String(value);
}

async function hmacSha512Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function makePaymobGateway(apiKey: string, integrationId: string, hmacSecret: string, iframeId: string): PaymobGateway {
  async function authenticate(): Promise<string> {
    const response = await fetch(`${BASE_URL}/api/auth/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey }),
    });
    if (!response.ok) throw new Error(`Paymob auth failed: ${response.status}`);
    const json = (await response.json()) as { token: string };
    return json.token;
  }

  async function registerOrder(authToken: string, amountCents: number, merchantOrderId: string): Promise<string> {
    const response = await fetch(`${BASE_URL}/api/ecommerce/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_token: authToken,
        delivery_needed: false, // digital product, no physical delivery
        amount_cents: amountCents,
        currency: "EGP",
        merchant_order_id: merchantOrderId,
        items: [],
      }),
    });
    if (!response.ok) throw new Error(`Paymob order registration failed: ${response.status}`);
    const json = (await response.json()) as { id: number };
    return String(json.id);
  }

  async function requestPaymentKey(
    authToken: string,
    amountCents: number,
    orderId: string,
    billingEmail: string,
    billingName: string
  ): Promise<string> {
    const [firstName, ...rest] = billingName.trim().split(/\s+/);
    // Digital product: no shipping address exists to collect. Paymob's billing_data schema
    // requires these fields to be present, so they're filled with honest, clearly-non-personal
    // placeholders -- never presented as real customer data -- rather than left absent, which is
    // the documented pattern for Paymob integrations with no physical delivery.
    const response = await fetch(`${BASE_URL}/api/acceptance/payment_keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_token: authToken,
        amount_cents: amountCents,
        expiration: 3600,
        order_id: orderId,
        currency: "EGP",
        integration_id: integrationId,
        billing_data: {
          email: billingEmail,
          first_name: firstName || "FPL",
          last_name: rest.join(" ") || "Edge",
          phone_number: "NA",
          street: "NA",
          building: "NA",
          floor: "NA",
          apartment: "NA",
          city: "NA",
          state: "NA",
          country: "NA",
          postal_code: "NA",
        },
      }),
    });
    if (!response.ok) throw new Error(`Paymob payment key request failed: ${response.status}`);
    const json = (await response.json()) as { token: string };
    return json.token;
  }

  return {
    async createCheckoutSession({ amountCents, merchantOrderId, billingEmail, billingName }) {
      const authToken = await authenticate();
      const orderId = await registerOrder(authToken, amountCents, merchantOrderId);
      const paymentKey = await requestPaymentKey(authToken, amountCents, orderId, billingEmail, billingName);
      return { orderId, url: `${BASE_URL}/api/acceptance/iframes/${iframeId}?payment_token=${paymentKey}` };
    },
    async verifyAndParseCallback(rawBody, hmacFromQuery) {
      if (!hmacFromQuery) return null;
      let parsed: { obj?: Record<string, unknown> };
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return null;
      }
      const transactionObject = parsed.obj;
      if (!transactionObject) return null;

      const sortedFields = [...HMAC_FIELDS].sort();
      const concatenated = sortedFields.map((field) => fieldValue(transactionObject, field)).join("");
      const computedHmac = await hmacSha512Hex(hmacSecret, concatenated);
      if (!timingSafeEqual(computedHmac, hmacFromQuery)) return null;

      const order = transactionObject.order as { id?: number } | undefined;
      return {
        orderId: String(order?.id ?? ""),
        success: transactionObject.success === true,
        pending: transactionObject.pending === true,
        isRefunded: transactionObject.is_refunded === true,
        isVoided: transactionObject.is_voided === true,
      };
    },
  };
}
