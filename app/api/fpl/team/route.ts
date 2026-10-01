import { getCurrentUser } from "../../../lib/auth";
import {
  evaluatePersonalAuthManageGate,
  tryFetchLiveTeamFinance,
} from "../../../lib/personal-fpl-transfer";
import { readRuntimeEnv } from "../../../lib/runtime-env";
import { OFFICIAL_FPL_API as FPL, buildTeamResponse, parseTransferLegs } from "../../../lib/team-response";

export async function GET(request: Request) {
  const entry = new URL(request.url).searchParams.get("entry")?.trim();
  if (!entry || !/^\d+$/.test(entry)) return Response.json({ error: "Enter a valid numeric FPL Team ID." }, { status: 400 });
  try {
    const headers = { Accept: "application/json", "User-Agent": "FPL-Edge/1.0" };
    const official = (url: string) => fetch(url, { headers, next: { revalidate: 300 } });
    const [managerResponse, bootstrapResponse, transfersResponse, env] = await Promise.all([
      official(`${FPL}/entry/${entry}/`),
      official(`${FPL}/bootstrap-static/`),
      official(`${FPL}/entry/${entry}/transfers/`),
      readRuntimeEnv(),
    ]);
    if (!managerResponse.ok || !bootstrapResponse.ok) throw new Error("That FPL Team ID was not found.");
    const [manager, bootstrap] = await Promise.all([managerResponse.json(), bootstrapResponse.json()]);
    const transfers = parseTransferLegs(transfersResponse.ok ? await transfersResponse.json() : []);

    const result = await buildTeamResponse({
      entry,
      manager,
      prices: { elements: bootstrap.elements ?? [], events: bootstrap.events },
      transfers,
      fetchOfficial: official,
      resolveLive: async () => {
        // Live my-team (pending next-GW transfers) — personal entry only, and only when the
        // caller is signed in + allowlisted (same gate as reconnect/health). Unauthenticated
        // or non-allowlisted callers get the public FPL path only — never bank/pending picks
        // from the personal refresh token.
        const user = await getCurrentUser();
        const manageGate = evaluatePersonalAuthManageGate(env, user?.email ?? null);
        const liveAttempt =
          manageGate.ok && manageGate.entryId === entry
            ? await tryFetchLiveTeamFinance(entry, env)
            : { ok: false as const, error: null };
        const liveFinance = liveAttempt.ok ? liveAttempt.finance : null;
        const liveOverlayError = liveAttempt.ok ? null : liveAttempt.error;
        // Personal entry + allowlisted session + failed live overlay: never rank on public history bank.
        const personalLiveRequired = manageGate.ok && manageGate.entryId === entry && liveOverlayError !== null;
        return { liveFinance, liveOverlayError, personalLiveRequired };
      },
    });
    return Response.json(result.body, result.status === 200 ? { headers: { "Cache-Control": "private, max-age=60" } } : { status: 409 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not import that FPL team." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
