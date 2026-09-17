import { isMissingTableError } from "../../../../db";
import { paymobConfigFromEnv } from "../../../lib/paymob";
import { readRuntimeEnv } from "../../../lib/runtime-env";
import { makeD1SeasonGrantRepo } from "../../../lib/season-access";
import { PaymobTransaction, grantSeasonAccessFromCallback } from "../../../lib/season-pass";

// Paymob Transaction Processed callback. HMAC is a query parameter (documented) and is sometimes
// also echoed on the JSON body. The redirect URL is not this route and must not grant access.
// https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac

function readTransaction(body: unknown): PaymobTransaction | null {
  if (!body || typeof body !== "object") return null;
  const obj = (body as { obj?: unknown }).obj;
  if (!obj || typeof obj !== "object") return null;
  return obj as PaymobTransaction;
}

export async function POST(request: Request) {
  const env = await readRuntimeEnv();
  const config = paymobConfigFromEnv(env);
  if (!config) return Response.json({ ok: false, reason: "not_configured" }, { status: 503 });

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, reason: "bad_signature" }, { status: 401 });
  }
  const transaction = readTransaction(body);
  if (!transaction) return Response.json({ ok: false, reason: "bad_signature" }, { status: 401 });

  const queryHmac = new URL(request.url).searchParams.get("hmac") ?? "";
  const bodyHmac = body && typeof body === "object" && typeof (body as { hmac?: unknown }).hmac === "string" ? (body as { hmac: string }).hmac : "";
  const receivedHmac = queryHmac || bodyHmac;

  try {
    const result = await grantSeasonAccessFromCallback(makeD1SeasonGrantRepo(), {
      hmacSecret: config.hmacSecret,
      receivedHmac,
      transaction,
      now: new Date(),
    });
    if (result.reason === "bad_signature") return Response.json({ ok: false, reason: result.reason }, { status: 401 });
    return Response.json({ ok: true, granted: result.granted, reason: result.reason });
  } catch (error) {
    console.error("season callback error:", error);
    if (isMissingTableError(error)) return Response.json({ ok: false, reason: "schema" }, { status: 503 });
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE")) return Response.json({ ok: true, granted: false, reason: "duplicate" });
    return Response.json({ ok: false, reason: "error" }, { status: 500 });
  }
}
