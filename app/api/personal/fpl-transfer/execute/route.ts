import { getCurrentUser } from "../../../../lib/auth";
import {
  buildTransferLeg,
  createRotatingTokenProvider,
  evaluatePersonalTransferGate,
  fetchMyTeam,
  loadPersonalRefreshToken,
  persistPersonalRefreshToken,
  postTransfers,
} from "../../../../lib/personal-fpl-transfer";
import { readRuntimeEnv } from "../../../../lib/runtime-env";

type Body = {
  elementOut?: number;
  elementIn?: number;
  event?: number;
  purchasePriceTenths?: number;
  confirmed?: boolean;
};

export async function POST(request: Request) {
  const env = await readRuntimeEnv();
  const user = await getCurrentUser();
  const gate = evaluatePersonalTransferGate(env, user?.email ?? null);
  if (!gate.ok) {
    return Response.json({ error: "Personal transfer execution is not available.", reason: gate.reason }, { status: 403 });
  }

  const refreshToken = await loadPersonalRefreshToken(env);
  if (!refreshToken) {
    return Response.json({ error: "FPL refresh token is not configured.", reason: "missing-refresh-token" }, { status: 503 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const elementOut = Number(body.elementOut);
  const elementIn = Number(body.elementIn);
  const event = Number(body.event);
  const purchasePriceTenths = Number(body.purchasePriceTenths);
  const confirmed = body.confirmed === true;
  if (![elementOut, elementIn, event, purchasePriceTenths].every((n) => Number.isFinite(n) && n > 0)) {
    return Response.json({ error: "elementOut, elementIn, event, and purchasePriceTenths are required." }, { status: 400 });
  }

  try {
    const tokens = await createRotatingTokenProvider(refreshToken, persistPersonalRefreshToken);
    const myTeam = await fetchMyTeam(gate.entryId, tokens);
    const leg = buildTransferLeg(myTeam, elementOut, elementIn, purchasePriceTenths);
    const result = await postTransfers(
      {
        chip: null,
        entry: Number(gate.entryId),
        event,
        transfers: [leg],
        confirmed,
      },
      tokens,
    );
    if (result.status >= 400) {
      return Response.json(
        {
          ok: false,
          confirmed,
          status: result.status,
          // FPL error payloads are safe operational detail; never include tokens.
          fpl: result.body,
        },
        { status: 502 },
      );
    }
    return Response.json({
      ok: true,
      confirmed,
      status: result.status,
      transfer: {
        elementOut,
        elementIn,
        sellingPrice: leg.selling_price,
        purchasePrice: leg.purchase_price,
        event,
      },
      fpl: result.body,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Transfer failed.";
    // Strip any accidental token-looking substrings from error text before returning.
    const safe = message.replace(/eyJ[a-zA-Z0-9_-]{10,}/g, "[redacted]");
    return Response.json({ error: safe }, { status: 502 });
  }
}
