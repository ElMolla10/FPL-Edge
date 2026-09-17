import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { makePaymobGateway } from "../app/lib/billing/paymob-gateway.ts";

const HMAC_SECRET = "test-hmac-secret";

// Independently computed with Node's classic crypto API (not the Web Crypto the gateway itself
// uses) -- if both implementations of the same HMAC-SHA512 spec agree, that's real cross-checked
// confidence in the algorithm, not just in one code path.
function referenceHmac(sortedConcatenatedValue: string): string {
  return createHmac("sha512", HMAC_SECRET).update(sortedConcatenatedValue).digest("hex");
}

// One realistic transaction object with all 20 HMAC-covered fields plus a couple of extras
// (Paymob's real payload has more fields than just these 20) to confirm extra fields are ignored.
const transactionObject = {
  amount_cents: 5000,
  created_at: "2026-05-01T12:00:00Z",
  currency: "EGP",
  error_occured: false,
  has_parent_transaction: false,
  id: 987654,
  integration_id: 111,
  is_3d_secure: true,
  is_auth: false,
  is_capture: false,
  is_refunded: false,
  is_standalone_payment: true,
  is_voided: false,
  order: { id: 555 },
  owner: 222,
  pending: false,
  source_data: { pan: "1234", sub_type: "Visa", type: "card" },
  success: true,
  // extras the HMAC does NOT cover -- included to prove they're ignored
  currency_display: "EGP",
  extra_unrelated_field: "should not affect the hmac",
};

// Sorted lexicographically (the actual rule, per Paymob's own docs, not a memorized sequence) --
// computed independently here rather than copy-pasted from the gateway's own field list, so a bug
// in either place's ordering would surface as a mismatch, not agree with itself.
const HMAC_FIELDS_SORTED = [
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
].sort();

function fieldValue(path: string): string {
  const parts = path.split(".");
  let node: unknown = transactionObject;
  for (const part of parts) node = (node as Record<string, unknown>)[part];
  return String(node);
}

function validHmacFor(body: unknown): string {
  const concatenated = HMAC_FIELDS_SORTED.map(fieldValue).join("");
  return referenceHmac(concatenated);
}

test("verifyAndParseCallback: a correctly-signed callback verifies and parses the transaction", async () => {
  const gateway = makePaymobGateway("api-key", "111", HMAC_SECRET, "iframe-id");
  const body = JSON.stringify({ obj: transactionObject });
  const hmac = validHmacFor(transactionObject);
  const result = await gateway.verifyAndParseCallback(body, hmac);
  assert.deepEqual(result, { orderId: "555", success: true, pending: false, isRefunded: false, isVoided: false });
});

test("verifyAndParseCallback: a wrong hmac is rejected (returns null, not a partially-trusted object)", async () => {
  const gateway = makePaymobGateway("api-key", "111", HMAC_SECRET, "iframe-id");
  const body = JSON.stringify({ obj: transactionObject });
  const result = await gateway.verifyAndParseCallback(body, "0".repeat(128));
  assert.equal(result, null);
});

test("verifyAndParseCallback: a hmac computed with the wrong secret is rejected", async () => {
  const gateway = makePaymobGateway("api-key", "111", HMAC_SECRET, "iframe-id");
  const body = JSON.stringify({ obj: transactionObject });
  const wrongSecretHmac = createHmac("sha512", "wrong-secret").update(HMAC_FIELDS_SORTED.map(fieldValue).join("")).digest("hex");
  const result = await gateway.verifyAndParseCallback(body, wrongSecretHmac);
  assert.equal(result, null);
});

test("verifyAndParseCallback: missing hmac query param is rejected outright", async () => {
  const gateway = makePaymobGateway("api-key", "111", HMAC_SECRET, "iframe-id");
  const body = JSON.stringify({ obj: transactionObject });
  const result = await gateway.verifyAndParseCallback(body, null);
  assert.equal(result, null);
});

test("verifyAndParseCallback: malformed JSON body is rejected, not thrown", async () => {
  const gateway = makePaymobGateway("api-key", "111", HMAC_SECRET, "iframe-id");
  const result = await gateway.verifyAndParseCallback("{not valid json", "somehmac");
  assert.equal(result, null);
});

test("verifyAndParseCallback: a body with no obj key is rejected", async () => {
  const gateway = makePaymobGateway("api-key", "111", HMAC_SECRET, "iframe-id");
  const result = await gateway.verifyAndParseCallback(JSON.stringify({ notObj: true }), "somehmac");
  assert.equal(result, null);
});

test("verifyAndParseCallback: reflects is_refunded and is_voided correctly", async () => {
  const gateway = makePaymobGateway("api-key", "111", HMAC_SECRET, "iframe-id");
  const refundedTransaction = { ...transactionObject, is_refunded: true };
  const body = JSON.stringify({ obj: refundedTransaction });
  const concatenated = HMAC_FIELDS_SORTED.map((path) => {
    const parts = path.split(".");
    let node: unknown = refundedTransaction;
    for (const part of parts) node = (node as Record<string, unknown>)[part];
    return String(node);
  }).join("");
  const hmac = referenceHmac(concatenated);
  const result = await gateway.verifyAndParseCallback(body, hmac);
  assert.equal(result?.isRefunded, true);
});
