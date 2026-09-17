import { isMissingTableError } from "../../../../db";
import type { UserRepo } from "../../../lib/auth-core";
import { makeD1UserRepo } from "../../../lib/auth";
import { getPaymobEnv } from "../../../lib/billing/env";
import { makePaymobGateway, PaymobGateway } from "../../../lib/billing/paymob-gateway";
import { makeD1PendingPaymentsRepo, PendingPaymentsRepo } from "../../../lib/billing/pending-payments";
import { handlePaymobTransactionWith } from "../../../lib/billing/webhook-handler";

// This is the "Transaction Processed" server-to-server callback ONLY -- Paymob's other callback
// (the GET "Transaction Response" redirect the user's browser lands on) is never wired to grant or
// revoke anything, same discipline the Stripe design already had toward its own success_url
// redirect. DI'd on the gateway and both repos so this is unit-tested end-to-end against mocks --
// no real Paymob credentials exist yet (see tests/billing-webhook.test.mts).
export function createWebhookRoute(
  userRepo: () => Promise<UserRepo>,
  pendingPayments: () => Promise<PendingPaymentsRepo>,
  gateway: () => Promise<PaymobGateway>
) {
  return async function POST(request: Request): Promise<Response> {
    // The hmac lives in the query string, not a header -- see paymob-gateway.ts's
    // verifyAndParseCallback for why this differs from Stripe's raw-body/header model.
    const hmacFromQuery = new URL(request.url).searchParams.get("hmac");
    const rawBody = await request.text();

    try {
      const paymob = await gateway();
      const transaction = await paymob.verifyAndParseCallback(rawBody, hmacFromQuery);
      if (!transaction) {
        // An unverifiable signature is a 400 (client's fault), not a 500 -- no reason to have
        // Paymob retry a callback whose signature will never verify.
        return Response.json({ error: "Callback signature verification failed." }, { status: 400 });
      }
      const result = await handlePaymobTransactionWith(await userRepo(), await pendingPayments(), transaction);
      return Response.json(result);
    } catch (error) {
      console.error("billing webhook error:", error);
      if (isMissingTableError(error)) {
        return Response.json({ error: "The database schema isn't set up yet. Apply the migration (see README.md) and try again." }, { status: 503 });
      }
      return Response.json({ error: "Could not process callback." }, { status: 500 });
    }
  };
}

export const POST = createWebhookRoute(
  async () => makeD1UserRepo(),
  async () => makeD1PendingPaymentsRepo(),
  async () => {
    const { apiKey, integrationId, hmacSecret, iframeId } = await getPaymobEnv();
    return makePaymobGateway(apiKey, integrationId, hmacSecret, iframeId);
  }
);
