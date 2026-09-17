import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SEASON_FALLBACK_END_ISO,
  SEASON_FALLBACK_KEY,
  SEASON_PASS_PRICE_EGP,
  SEASON_PASS_PRICE_PIASTERS,
  CheckoutRecord,
  PaymobTransaction,
  SeasonGrantRepo,
  SeasonPassRecord,
  devSeasonGrantEnabled,
  formatSeasonPassPrice,
  grantSeasonAccessFromCallback,
  isSeasonPassActive,
  paymobProcessedCallbackMessage,
  resolveSeasonWindow,
} from "../app/lib/season-pass.ts";

const NOW = new Date("2026-09-18T00:00:00.000Z");

function weeklyEvents(count: number, startIso = "2026-08-14T17:00:00.000Z") {
  const start = Date.parse(startIso);
  return Array.from({ length: count }, (_, index) => ({ deadline: new Date(start + index * 7 * 86_400_000).toISOString() }));
}

test("price is 399 EGP, which is 39900 piasters, from one constant", () => {
  assert.equal(SEASON_PASS_PRICE_EGP, 399);
  assert.equal(SEASON_PASS_PRICE_PIASTERS, 39900);
  assert.equal(SEASON_PASS_PRICE_PIASTERS, SEASON_PASS_PRICE_EGP * 100);
  assert.equal(formatSeasonPassPrice(), "399 EGP");
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /formatSeasonPassPrice\(\)/);
  assert.match(page, />0 EGP</);
  assert.doesNotMatch(page, /Coming soon/);
  assert.doesNotMatch(page, /<strong>£0<\/strong>/);
});

test("a pass is active only inside its window", () => {
  const pass: SeasonPassRecord = {
    userId: "user-1",
    seasonKey: "2026/27",
    startsAt: "2026-09-18T00:00:00.000Z",
    endsAt: "2027-05-31T20:59:59.999Z",
    status: "active",
  };
  assert.equal(isSeasonPassActive(pass, new Date(pass.startsAt)), true);
  assert.equal(isSeasonPassActive(pass, new Date("2027-01-15T12:00:00.000Z")), true);
  assert.equal(isSeasonPassActive(pass, new Date(pass.endsAt)), true);
  assert.equal(isSeasonPassActive(pass, new Date(Date.parse(pass.endsAt) + 1)), false);
  assert.equal(isSeasonPassActive(pass, new Date(Date.parse(pass.startsAt) - 1)), false);
});

test("an expired or missing pass is not active, and a purchase does not start a new year", () => {
  assert.equal(isSeasonPassActive(null, NOW), false);
  assert.equal(isSeasonPassActive(undefined, NOW), false);
  const expired: SeasonPassRecord = {
    userId: "user-1",
    seasonKey: "2025/26",
    startsAt: "2025-08-15T00:00:00.000Z",
    endsAt: "2026-05-31T20:59:59.999Z",
    status: "active",
  };
  assert.equal(isSeasonPassActive(expired, NOW), false);
  assert.equal(isSeasonPassActive({ ...expired, endsAt: "2027-05-31T20:59:59.999Z", status: "pending" }, NOW), false);

  const events = weeklyEvents(38);
  const window = resolveSeasonWindow(events, NOW);
  assert.equal(window.source, "fpl-events");
  assert.equal(window.seasonKey, "2026/27");
  const purchase = new Date("2026-12-01T00:00:00.000Z");
  const bought: SeasonPassRecord = {
    userId: "user-1",
    seasonKey: window.seasonKey,
    startsAt: purchase.toISOString(),
    endsAt: window.endsAt,
    status: "active",
  };
  assert.equal(isSeasonPassActive(bought, new Date("2027-02-01T00:00:00.000Z")), true);
  const oneYearAfterPurchase = purchase.getTime() + 365 * 86_400_000;
  assert.ok(Date.parse(window.endsAt) < oneYearAfterPurchase, "season end must not be a rolling year from purchase");
  assert.equal(isSeasonPassActive(bought, new Date(oneYearAfterPurchase)), false);
});

test("unreliable event data uses the 31 May 2027 Cairo fallback, not a made-up window", () => {
  for (const events of [[], weeklyEvents(5), weeklyEvents(38, "2020-08-14T17:00:00.000Z")]) {
    const window = resolveSeasonWindow(events, NOW);
    assert.equal(window.source, "fallback");
    assert.equal(window.endsAt, SEASON_FALLBACK_END_ISO);
    assert.equal(window.seasonKey, SEASON_FALLBACK_KEY);
  }
  assert.equal(SEASON_FALLBACK_END_ISO, "2027-05-31T20:59:59.999Z");
});

test("dev grant flag cannot turn on in production or when unset", () => {
  assert.equal(devSeasonGrantEnabled({}), false);
  assert.equal(devSeasonGrantEnabled({ FPL_EDGE_DEV_SEASON_GRANT: "1" }), false);
  assert.equal(devSeasonGrantEnabled({ FPL_EDGE_DEV_SEASON_GRANT: "1", NODE_ENV: "production" }), false);
  assert.equal(devSeasonGrantEnabled({ FPL_EDGE_DEV_SEASON_GRANT: "true", NODE_ENV: "development" }), false);
  assert.equal(devSeasonGrantEnabled({ FPL_EDGE_DEV_SEASON_GRANT: "1", NODE_ENV: "development" }), true);
  assert.equal(devSeasonGrantEnabled({ FPL_EDGE_DEV_SEASON_GRANT: "1", NODE_ENV: "test" }), true);
});

const PAYMOB_SAMPLE: PaymobTransaction = {
  amount_cents: 100,
  created_at: "2020-03-25T18:39:44.719228",
  currency: "EGP",
  error_occured: false,
  has_parent_transaction: false,
  id: 2556706,
  integration_id: 6741,
  is_3d_secure: true,
  is_auth: false,
  is_capture: false,
  is_refunded: false,
  is_standalone_payment: true,
  is_voided: false,
  order: { id: 4778239 },
  owner: 4705,
  pending: false,
  source_data: { pan: "2346", sub_type: "MasterCard", type: "card" },
  success: true,
};

test("Paymob HMAC concatenation matches the documented Transaction Processed example", () => {
  assert.equal(
    paymobProcessedCallbackMessage(PAYMOB_SAMPLE),
    "1002020-03-25T18:39:44.719228EGPfalsefalse25567066741truefalsefalsefalsetruefalse47782394705false2346MasterCardcardtrue",
  );
});

function sampleCharge(overrides: Partial<PaymobTransaction> = {}): PaymobTransaction {
  return {
    amount_cents: SEASON_PASS_PRICE_PIASTERS,
    created_at: "2026-09-18T12:00:00.000000",
    currency: "EGP",
    error_occured: false,
    has_parent_transaction: false,
    id: 9001,
    integration_id: 111,
    is_3d_secure: true,
    is_auth: false,
    is_capture: false,
    is_refunded: false,
    is_standalone_payment: true,
    is_voided: false,
    order: { id: 555, merchant_order_id: "attacker-controlled-and-unsigned" },
    owner: 1,
    pending: false,
    source_data: { pan: "2346", sub_type: "MasterCard", type: "card" },
    success: true,
    ...overrides,
  };
}

function makeRepo(checkout: CheckoutRecord | null): SeasonGrantRepo & { saves: number; paid: number } {
  const state = { saves: 0, paid: 0, checkout };
  return {
    saves: 0,
    paid: 0,
    async findCheckoutByPaymobOrderId(orderId) {
      return state.checkout && state.checkout.paymobOrderId === orderId ? { ...state.checkout } : null;
    },
    async findPassByTransactionId() {
      return null;
    },
    async findCoveringPass() {
      return null;
    },
    async markCheckoutPaid() {
      state.paid++;
      this.paid = state.paid;
      if (state.checkout) state.checkout = { ...state.checkout, status: "paid" };
    },
    async savePass() {
      state.saves++;
      this.saves = state.saves;
    },
  };
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("a callback with a bad signature does not grant access", async () => {
  const secret = "merchant-hmac-secret";
  const transaction = sampleCharge();
  const repo = makeRepo({
    id: "checkout-1",
    userId: "user-1",
    seasonKey: "2026/27",
    endsAt: "2027-05-31T20:59:59.999Z",
    amountPiasters: SEASON_PASS_PRICE_PIASTERS,
    currency: "EGP",
    status: "pending",
    paymobOrderId: "555",
  });
  const bad = await grantSeasonAccessFromCallback(repo, {
    hmacSecret: secret,
    receivedHmac: "ab".repeat(64),
    transaction,
    now: new Date("2026-09-18T12:05:00.000Z"),
  });
  assert.equal(bad.granted, false);
  assert.equal(bad.reason, "bad_signature");
  assert.equal(repo.saves, 0);
  assert.equal(repo.paid, 0);

  const signed = await hmac(secret, paymobProcessedCallbackMessage(transaction));
  const tampered = await grantSeasonAccessFromCallback(repo, {
    hmacSecret: secret,
    receivedHmac: signed,
    transaction: { ...transaction, success: false },
    now: new Date("2026-09-18T12:05:00.000Z"),
  });
  assert.equal(tampered.granted, false);
  assert.equal(tampered.reason, "bad_signature");
  assert.equal(repo.saves, 0);

  const good = await grantSeasonAccessFromCallback(repo, {
    hmacSecret: secret,
    receivedHmac: signed,
    transaction,
    now: new Date("2026-09-18T12:05:00.000Z"),
  });
  assert.equal(good.granted, true);
  assert.equal(good.reason, "granted");
  assert.equal(repo.saves, 1);
  assert.equal(repo.paid, 1);
});

test("ui gates the full desk from the server session and does not offer a free unlock", () => {
  const coach = readFileSync(new URL("../app/components/CoachApp.tsx", import.meta.url), "utf8");
  const dev = readFileSync(new URL("../app/api/season-pass/dev-grant/route.ts", import.meta.url), "utf8");
  const callback = readFileSync(new URL("../app/api/season-pass/callback/route.ts", import.meta.url), "utf8");
  assert.match(coach, /desk==="free"/);
  assert.match(coach, /PRO_VIEWS/);
  assert.match(coach, /\/api\/auth\/me/);
  assert.doesNotMatch(coach, /unlock for free|Unlock for free|dev-grant/i);
  assert.match(dev, /devSeasonGrantEnabled/);
  assert.match(callback, /grantSeasonAccessFromCallback/);
  assert.doesNotMatch(callback, /status:\s*"active"/);
});

test("payment lives on its own page", () => {
  const pay = readFileSync(new URL("../app/pay/page.tsx", import.meta.url), "utf8");
  const home = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const coach = readFileSync(new URL("../app/components/CoachApp.tsx", import.meta.url), "utf8");
  const checkout = readFileSync(new URL("../app/api/season-pass/checkout/route.ts", import.meta.url), "utf8");
  assert.match(pay, /SeasonUpgrade/);
  assert.match(home, /href="\/pay"/);
  assert.match(coach, /window\.location\.assign\("\/pay"\)/);
  assert.doesNotMatch(coach, /SeasonUpgrade/);
  assert.match(checkout, /\/pay\?checkout=return/);
});
