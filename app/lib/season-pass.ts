// Pure season-pass rules: price, window, and Paymob callback decisions. No Cloudflare, D1, or
// Next.js imports, so node --import tsx can test this the same way as auth-core
// (tests/season-pass.test.mts). D1 wiring lives in app/lib/season-access.ts.

export const SEASON_PASS_PRICE_EGP = 399;
export const SEASON_PASS_PRICE_PIASTERS = SEASON_PASS_PRICE_EGP * 100;

// Fallback when bootstrap-static events cannot define the current season. End of 31 May 2027
// in Africa/Cairo (UTC+3): 23:59:59.999 local = 20:59:59.999 UTC. One constant, used everywhere
// the event calendar is missing or not shaped like a Premier League season.
export const SEASON_FALLBACK_END_ISO = "2027-05-31T20:59:59.999Z";
export const SEASON_FALLBACK_KEY = "2026/27";

const DAY_MS = 86_400_000;
const MIN_EVENTS_FOR_RELIABLE_SEASON = 30;
const MIN_SEASON_SPAN_MS = 150 * DAY_MS;
const MAX_SEASON_SPAN_MS = 400 * DAY_MS;
const FINAL_MATCHWEEK_GRACE_MS = 14 * DAY_MS;
const SEASON_STILL_OPEN_GRACE_MS = 21 * DAY_MS;

export type SeasonWindow = {
  seasonKey: string;
  endsAt: string;
  source: "fpl-events" | "fallback";
};

export function formatSeasonPassPrice(amountEgp: number = SEASON_PASS_PRICE_EGP): string {
  return `${amountEgp} EGP`;
}

// A reliable calendar is a full-looking FPL event list (about 38 weekly deadlines spanning one
// season, latest deadline not long in the past). Anything else uses the named fallback so a
// partial or empty feed cannot invent a new 12-month window from the purchase date.
export function resolveSeasonWindow(events: readonly { deadline: string }[], now: Date): SeasonWindow {
  const deadlines = events
    .map((event) => Date.parse(event.deadline))
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => a - b);
  const latest = deadlines.length ? deadlines[deadlines.length - 1] : Number.NaN;
  const span = deadlines.length ? latest - deadlines[0] : 0;
  const reliable =
    deadlines.length >= MIN_EVENTS_FOR_RELIABLE_SEASON &&
    span >= MIN_SEASON_SPAN_MS &&
    span <= MAX_SEASON_SPAN_MS &&
    latest >= now.getTime() - SEASON_STILL_OPEN_GRACE_MS;
  if (!reliable) {
    return { seasonKey: SEASON_FALLBACK_KEY, endsAt: SEASON_FALLBACK_END_ISO, source: "fallback" };
  }
  const first = new Date(deadlines[0]);
  const year = first.getUTCMonth() >= 6 ? first.getUTCFullYear() : first.getUTCFullYear() - 1;
  const seasonKey = `${year}/${String((year + 1) % 100).padStart(2, "0")}`;
  return {
    seasonKey,
    endsAt: new Date(latest + FINAL_MATCHWEEK_GRACE_MS).toISOString(),
    source: "fpl-events",
  };
}

export type SeasonPassRecord = {
  userId: string;
  seasonKey: string;
  startsAt: string;
  endsAt: string;
  status: "active";
};

// Active means a real record whose status is active and `now` sits inside [startsAt, endsAt].
// Missing, pending, or out-of-window records are not active. The window end is the season end,
// not a year counted from purchase.
export function isSeasonPassActive(
  pass: { startsAt: string; endsAt: string; status: string } | null | undefined,
  now: Date,
): boolean {
  if (!pass || pass.status !== "active") return false;
  const start = Date.parse(pass.startsAt);
  const end = Date.parse(pass.endsAt);
  const time = now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return time >= start && time <= end;
}

// Off unless the flag is exactly "1" AND NODE_ENV is development or test. Unset NODE_ENV and
// production both refuse, so copying the flag into a production secret store cannot enable it.
export function devSeasonGrantEnabled(env: { FPL_EDGE_DEV_SEASON_GRANT?: string; NODE_ENV?: string }): boolean {
  const nodeEnv = env.NODE_ENV;
  const nonProduction = nodeEnv === "development" || nodeEnv === "test";
  return env.FPL_EDGE_DEV_SEASON_GRANT === "1" && nonProduction;
}

export function normalizeCheckoutPhone(input: string): string | null {
  const compact = input.trim().replace(/[\s()-]/g, "");
  if (!compact) return null;
  let digits = compact.startsWith("+") ? compact.slice(1) : compact;
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (/^0\d{10}$/.test(digits)) digits = `20${digits.slice(1)}`;
  if (/^1\d{9}$/.test(digits)) digits = `20${digits}`;
  if (!/^20\d{9,10}$/.test(digits)) return null;
  return `+${digits}`;
}

// Transaction Processed callback HMAC, as documented by Paymob:
// https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac
// The real rule is these fields sorted lexicographically, not a fixed declared sequence --
// paymobHmacMessageFromFields below sorts this literal at runtime so the order is enforced by
// an actual algorithm, not by this array coincidentally already being alphabetical. Concatenate
// the sorted fields with no separator, then HMAC-SHA512, lowercase hex. The hmac query parameter
// is compared to that digest. Fields not in this list (including merchant_order_id) are not
// authenticated — correlate orders by order.id, which is.
export const PAYMOB_HMAC_FIELDS = [
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
] as const;

export type PaymobTransaction = {
  amount_cents?: unknown;
  created_at?: unknown;
  currency?: unknown;
  error_occured?: unknown;
  has_parent_transaction?: unknown;
  id?: unknown;
  integration_id?: unknown;
  is_3d_secure?: unknown;
  is_auth?: unknown;
  is_capture?: unknown;
  is_refunded?: unknown;
  is_standalone_payment?: unknown;
  is_voided?: unknown;
  order?: { id?: unknown; merchant_order_id?: unknown } | null;
  owner?: unknown;
  pending?: unknown;
  source_data?: { pan?: unknown; sub_type?: unknown; type?: unknown } | null;
  success?: unknown;
};

function hmacField(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function paymobField(transaction: PaymobTransaction, path: (typeof PAYMOB_HMAC_FIELDS)[number]): unknown {
  switch (path) {
    case "order.id":
      return transaction.order?.id;
    case "source_data.pan":
      return transaction.source_data?.pan;
    case "source_data.sub_type":
      return transaction.source_data?.sub_type;
    case "source_data.type":
      return transaction.source_data?.type;
    default:
      return transaction[path];
  }
}

// Sorts whatever field order it's given before building the message -- exported so a test can
// feed in a deliberately shuffled copy of PAYMOB_HMAC_FIELDS and prove the sort step, not the
// literal's declared order, is what determines the result.
export function paymobHmacMessageFromFields(transaction: PaymobTransaction, fields: readonly (typeof PAYMOB_HMAC_FIELDS)[number][]): string {
  return [...fields].sort().map((path) => hmacField(paymobField(transaction, path))).join("");
}

export function paymobProcessedCallbackMessage(transaction: PaymobTransaction): string {
  return paymobHmacMessageFromFields(transaction, PAYMOB_HMAC_FIELDS);
}

async function hmacSha512Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPaymobProcessedHmac(secret: string, receivedHmac: string, transaction: PaymobTransaction): Promise<boolean> {
  if (!secret || !receivedHmac) return false;
  const expected = await hmacSha512Hex(secret, paymobProcessedCallbackMessage(transaction));
  return timingSafeEqual(expected, receivedHmac.trim().toLowerCase());
}

export type CheckoutRecord = {
  id: string;
  userId: string;
  seasonKey: string;
  endsAt: string;
  amountPiasters: number;
  currency: string;
  status: "pending" | "paid";
  paymobOrderId: string | null;
};

export type SeasonGrantRepo = {
  findCheckoutByPaymobOrderId(orderId: string): Promise<CheckoutRecord | null>;
  findPassByTransactionId(transactionId: string): Promise<{ id: string } | null>;
  findCoveringPass(userId: string, now: Date): Promise<SeasonPassRecord | null>;
  markCheckoutPaid(checkoutId: string, paidAt: string): Promise<void>;
  savePass(pass: SeasonPassRecord & { id: string; amountPiasters: number; currency: string; source: "paymob"; paymobTransactionId: string }): Promise<void>;
  // Removes the active pass for this user/season if one exists (a void/refund callback for a
  // transaction that was already granted). Returns whether a pass actually existed to revoke,
  // so a void/refund on a checkout that was never granted still reports "void_or_refund", not
  // a false "revoked". Correlates by userId + seasonKey + endsAt (the same checkout identity
  // the grant path already trusts via order.id), not by transaction id -- a refund event may
  // carry its own transaction id distinct from the original charge's.
  revokeCoveringPass(userId: string, now: Date, seasonKey: string, endsAt: string): Promise<boolean>;
};

export type SeasonGrantResult = { granted: boolean; reason: string };

// Grants access only when the HMAC matches AND the signed transaction is a successful EGP
// charge for exactly the season price, matched to a pending checkout by the HMAC-covered
// order.id. A bad signature returns before any repository write.
export async function grantSeasonAccessFromCallback(
  repo: SeasonGrantRepo,
  input: { hmacSecret: string; receivedHmac: string; transaction: PaymobTransaction; now: Date },
): Promise<SeasonGrantResult> {
  const authentic = await verifyPaymobProcessedHmac(input.hmacSecret, input.receivedHmac, input.transaction);
  if (!authentic) return { granted: false, reason: "bad_signature" };

  const transaction = input.transaction;
  if (transaction.success !== true) return { granted: false, reason: "not_successful" };
  if (transaction.pending === true) return { granted: false, reason: "pending" };
  if (transaction.error_occured === true) return { granted: false, reason: "error" };
  if (transaction.is_voided === true || transaction.is_refunded === true) {
    // A void/refund can arrive for a transaction that was already granted a pass -- this must
    // actually remove that access, not just refuse to grant a *second* one. Correlate by
    // order.id (HMAC-covered, already the trusted key throughout this file) back to the
    // checkout's userId/seasonKey/endsAt, then revoke whatever pass currently covers that.
    const voidedOrderId = transaction.order?.id;
    if (voidedOrderId !== undefined && voidedOrderId !== null && String(voidedOrderId) !== "") {
      const voidedCheckout = await repo.findCheckoutByPaymobOrderId(String(voidedOrderId));
      if (voidedCheckout) {
        const revoked = await repo.revokeCoveringPass(voidedCheckout.userId, input.now, voidedCheckout.seasonKey, voidedCheckout.endsAt);
        if (revoked) return { granted: false, reason: "revoked" };
      }
    }
    return { granted: false, reason: "void_or_refund" };
  }
  if (String(transaction.currency ?? "").toUpperCase() !== "EGP") return { granted: false, reason: "currency" };
  if (Number(transaction.amount_cents) !== SEASON_PASS_PRICE_PIASTERS) return { granted: false, reason: "amount" };

  const orderId = transaction.order?.id;
  if (orderId === undefined || orderId === null || String(orderId) === "") return { granted: false, reason: "missing_order" };
  const transactionId = transaction.id === undefined || transaction.id === null ? "" : String(transaction.id);
  if (!transactionId) return { granted: false, reason: "missing_transaction" };

  const existing = await repo.findPassByTransactionId(transactionId);
  if (existing) return { granted: false, reason: "duplicate" };

  const checkout = await repo.findCheckoutByPaymobOrderId(String(orderId));
  if (!checkout) return { granted: false, reason: "unknown_order" };
  if (checkout.amountPiasters !== SEASON_PASS_PRICE_PIASTERS || checkout.currency.toUpperCase() !== "EGP") {
    return { granted: false, reason: "checkout_amount" };
  }
  const endsAt = Date.parse(checkout.endsAt);
  if (!Number.isFinite(endsAt) || endsAt < input.now.getTime()) return { granted: false, reason: "season_ended" };

  const covering = await repo.findCoveringPass(checkout.userId, input.now);
  if (checkout.status !== "paid") await repo.markCheckoutPaid(checkout.id, input.now.toISOString());
  if (covering) return { granted: false, reason: "already_active" };

  await repo.savePass({
    id: crypto.randomUUID(),
    userId: checkout.userId,
    seasonKey: checkout.seasonKey,
    startsAt: input.now.toISOString(),
    endsAt: checkout.endsAt,
    status: "active",
    amountPiasters: SEASON_PASS_PRICE_PIASTERS,
    currency: "EGP",
    source: "paymob",
    paymobTransactionId: transactionId,
  });
  return { granted: true, reason: "granted" };
}
