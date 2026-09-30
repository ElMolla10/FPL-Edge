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
import { bodyErrorResponse, parseTransferExecuteBody, readJsonBody, rejectCrossSite } from "../../../../lib/request-guards";
import { readRuntimeEnv } from "../../../../lib/runtime-env";

export async function POST(request: Request) {
  // FIRST check, before auth/env/FPL calls: this route can place a real transfer on a real FPL team.
  // Session cookie is SameSite=Lax; this is defence in depth (docs/SECURITY.md).
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
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

  let parsed;
  try {
    parsed = parseTransferExecuteBody(await readJsonBody(request));
  } catch (error) {
    const response = bodyErrorResponse(error);
    if (response) return response;
    throw error;
  }
  const { elementOut, elementIn, event, purchasePriceTenths, confirmed } = parsed;

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
