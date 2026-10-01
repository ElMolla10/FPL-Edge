/**
 * Server-side equivalent of the browser's "connect my FPL team": official picks + bank + selling prices for an
 * entry id, produced by the SAME buildTeamResponse() the /api/fpl/team route uses (app/lib/team-response.ts).
 * Official FPL endpoints only. Never an FPL password; the only credential involved is the pre-existing personal
 * refresh token path (owner allowlist), reached through the same helpers as the route.
 */
import type { FplData } from "../fpl";
import type { ManagerMeta } from "../squad-comparison";
import { evaluatePersonalAuthManageGate, tryFetchLiveTeamFinance, type PersonalTransferEnv } from "../personal-fpl-transfer";
import { OFFICIAL_FPL_API, buildTeamResponse, parseTransferLegs } from "../team-response";

export type LoadedTeam = { ok: true; manager: ManagerMeta; playerIds: number[] } | { ok: false; reason: string };
export type TeamLoader = (args: { entry: string; email: string }) => Promise<LoadedTeam>;

const FETCH_TIMEOUT_MS = 8_000;

export function createTeamLoader(data: FplData, env: PersonalTransferEnv, fetchImpl: typeof fetch = fetch): TeamLoader {
  const headers = { Accept: "application/json", "User-Agent": "FPL-Edge/1.0" };
  const official = (url: string) => fetchImpl(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  // Price book from the snapshot we already hold (no second bootstrap-static call). FplPlayer.price is now_cost/10
  // and priceChangeSinceStart is cost_change_start/10; buildTeamResponse wants the raw tenths.
  const prices = {
    elements: data.players.map((p) => ({ id: p.id, now_cost: Math.round(p.price * 10), cost_change_start: Math.round(p.priceChangeSinceStart * 10) })),
    events: data.events.map((e) => ({ id: e.id, finished: e.finished, is_current: e.current, is_next: e.next, deadline_time: e.deadline })),
  };
  return async ({ entry, email }) => {
    if (!/^\d{1,16}$/.test(entry)) return { ok: false, reason: "bad-entry" };
    try {
      const [managerResponse, transfersResponse] = await Promise.all([official(`${OFFICIAL_FPL_API}/entry/${entry}/`), official(`${OFFICIAL_FPL_API}/entry/${entry}/transfers/`)]);
      if (!managerResponse.ok) return { ok: false, reason: `entry-http-${managerResponse.status}` };
      const manager = await managerResponse.json();
      const transfers = parseTransferLegs(transfersResponse.ok ? await transfersResponse.json() : []);
      const result = await buildTeamResponse({
        entry,
        manager,
        prices,
        transfers,
        fetchOfficial: official,
        resolveLive: async () => {
          // Identical gate to the route: only the allowlisted owner's own entry gets the live my-team overlay.
          const gate = evaluatePersonalAuthManageGate(env, email);
          const live = gate.ok && gate.entryId === entry ? await tryFetchLiveTeamFinance(entry, env) : { ok: false as const, error: null };
          const liveFinance = live.ok ? live.finance : null;
          const liveOverlayError = live.ok ? null : live.error;
          return { liveFinance, liveOverlayError, personalLiveRequired: gate.ok && gate.entryId === entry && liveOverlayError !== null };
        },
      });
      if (result.status !== 200) return { ok: false, reason: "squad-not-public" };
      const body = result.body as { manager: ManagerMeta; playerIds: number[] };
      return { ok: true, manager: body.manager, playerIds: body.playerIds };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.name : "team-fetch-failed" };
    }
  };
}
