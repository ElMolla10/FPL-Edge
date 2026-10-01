/**
 * Builds the `/api/fpl/team` response body from official FPL data. Extracted from the route handler (no
 * behaviour change) so the Worker cron that sends email call alerts derives bank, selling prices, picks and
 * chip from the SAME code the site uses, instead of a parallel re-implementation.
 *
 * Pure of Next/Cloudflare imports: the caller supplies the already-fetched `manager`, the price book + events
 * (from bootstrap-static, or from FplData for the cron), a `fetchOfficial` for the per-event picks, and a lazy
 * `resolveLive` for the personal live-my-team overlay (the route gates that on the signed-in allowlisted
 * session; the cron gates it on the opted-in user's email in exactly the same way).
 */
import { deriveSellingPricesMillions, type FplTransferLeg } from "./fpl-selling-price";
import { resolveManagerActiveChip, resolveTransferBankMillions, type LiveTeamFinance, type LiveOverlayError } from "./personal-fpl-transfer";

export const OFFICIAL_FPL_API = "https://fantasy.premierleague.com/api";

export type OfficialEventLite = { id: number; finished: boolean; is_current: boolean; is_next: boolean; deadline_time: string };
export type OfficialPriceBook = { elements: { id: number; now_cost: number; cost_change_start: number }[]; events: OfficialEventLite[] };
export type LiveResolution = { liveFinance: LiveTeamFinance | null; liveOverlayError: LiveOverlayError | null; personalLiveRequired: boolean };

export function parseTransferLegs(transfersJson: unknown): FplTransferLeg[] {
  return Array.isArray(transfersJson)
    ? transfersJson.map((row: Record<string, unknown>) => ({
        element_in: Number(row.element_in),
        element_in_cost: Number(row.element_in_cost),
        element_out: Number(row.element_out),
        element_out_cost: Number(row.element_out_cost),
        event: Number(row.event) || undefined,
        time: typeof row.time === "string" ? row.time : undefined,
      }))
    : [];
}

export async function buildTeamResponse(args: {
  entry: string;
  // Raw official /entry/{id}/ JSON (untyped upstream payload, as before the extraction).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  manager: any;
  prices: OfficialPriceBook;
  transfers: FplTransferLeg[];
  fetchOfficial: (url: string) => Promise<Response>;
  resolveLive: () => Promise<LiveResolution>;
  nowMs?: number;
}): Promise<{ status: 200; body: Record<string, unknown> } | { status: 409; body: { error: string } }> {
  const { entry, manager, transfers, fetchOfficial } = args;
  const bootstrap = { elements: args.prices.elements, events: args.prices.events };
  const FPL = OFFICIAL_FPL_API;

  const elements: { id: number; now_cost: number; cost_change_start: number }[] = bootstrap.elements ?? [];
  const nowCostTenthsById = new Map(elements.map((el) => [el.id, Number(el.now_cost)]));
  const costChangeStartTenthsById = new Map(elements.map((el) => [el.id, Number(el.cost_change_start)]));

  // Prefer entry_history.bank (per-event) over last_deadline_bank on the entry summary — they
  // usually match after the deadline, but history is what the GW picks payload already exposes.
  // When personal my-team is available for this entry, live transfers.bank wins (see below).
  const entryBankTenths = Number(manager.last_deadline_bank);

  const candidateEvents = bootstrap.events
    .filter(
      (event: { finished: boolean; is_current: boolean; is_next: boolean; deadline_time: string }) =>
        event.finished || event.is_current || (event.is_next && Date.parse(event.deadline_time) <= (args.nowMs ?? Date.now())),
    )
    .sort((a: { id: number }, b: { id: number }) => b.id - a.id);

  // Live my-team (pending next-GW transfers): resolved by the caller. The route only resolves it for a signed-in
  // allowlisted session on the personal entry; unauthenticated or non-allowlisted callers get the public FPL
  // path only, never bank/pending picks from the personal refresh token. Personal entry + failed live overlay:
  // never rank on public history bank (personalLiveRequired).
  const { liveFinance, liveOverlayError, personalLiveRequired } = await args.resolveLive();

  for (const event of candidateEvents) {
    const picksResponse = await fetchOfficial(`${FPL}/entry/${entry}/event/${event.id}/picks/`);
    if (!picksResponse.ok) continue;
    const picks = await picksResponse.json();
    const history = picks.entry_history || {};
    const captain = picks.picks.find((pick: { is_captain: boolean }) => pick.is_captain);
    const viceCaptain = picks.picks.find((pick: { is_vice_captain: boolean }) => pick.is_vice_captain);

    const publicOwnedIds: number[] = picks.picks.map((pick: { element: number }) => Number(pick.element));
    const officialFromPicks = new Map<number, number>();
    for (const pick of picks.picks) {
      // Public event picks omit selling_price; authenticated my-team includes it. Coerce only when present.
      if (Number.isFinite(Number(pick.selling_price))) {
        officialFromPicks.set(Number(pick.element), Number(pick.selling_price) / 10);
      }
    }

    // Live my-team selling prices are authoritative when present (and match live player ids).
    if (liveFinance) {
      for (const [id, price] of liveFinance.sellingMillionsById) {
        officialFromPicks.set(id, price);
      }
    }

    const ownedIds = liveFinance?.playerIds ?? publicOwnedIds;

    const derivedSelling = deriveSellingPricesMillions({
      ownedElementIds: ownedIds,
      nowCostTenthsById: nowCostTenthsById,
      costChangeStartTenthsById: costChangeStartTenthsById,
      transfers,
      officialSellingMillionsById: officialFromPicks,
    });

    const historyBank = Number(history.bank);
    const bankFromHistory = Number.isFinite(historyBank) ? historyBank / 10 : null;
    const bankFromEntry = Number.isFinite(entryBankTenths) ? entryBankTenths / 10 : null;
    // Prefer the event picks history bank; fall back to entry last_deadline_bank when history is missing.
    const historyResolved = bankFromHistory ?? bankFromEntry;
    const bankResolved = resolveTransferBankMillions({
      historyBankMillions: historyResolved,
      liveBankMillions: liveFinance?.bankMillions,
      disallowHistoryFallback: personalLiveRequired,
    });
    const rankingFinance =
      bankResolved.source === "unavailable" || personalLiveRequired
        ? "unavailable"
        : "ready";
    // Diagnostics only — clients must not rank on this when rankingFinance is unavailable.
    const publicHistoryBank = historyResolved;

    const responsePicks = liveFinance
      ? liveFinance.picks.map((pick) => ({
          elementId: pick.elementId,
          position: pick.position,
          multiplier: pick.multiplier,
          isCaptain: pick.isCaptain,
          isViceCaptain: pick.isViceCaptain,
          sellingPrice: pick.sellingPrice,
        }))
      : picks.picks.map((pick: Record<string, unknown>) => {
          const elementId = Number(pick.element);
          const fromOfficial = Number.isFinite(Number(pick.selling_price))
            ? Number(pick.selling_price) / 10
            : null;
          const derived = derivedSelling.get(elementId);
          const sellingPrice =
            fromOfficial !== null
              ? fromOfficial
              : typeof derived === "number" && Number.isFinite(derived)
                ? derived
                : null;
          return {
            elementId,
            position: Number(pick.position),
            multiplier: Number(pick.multiplier),
            isCaptain: Boolean(pick.is_captain),
            isViceCaptain: Boolean(pick.is_vice_captain),
            sellingPrice,
          };
        });

    // Captain/vice: prefer live my-team armbands when overlaying pending squad.
    const liveCaptain = liveFinance?.picks.find((pick) => pick.isCaptain)?.elementId ?? null;
    const liveVice = liveFinance?.picks.find((pick) => pick.isViceCaptain)?.elementId ?? null;

    return { status: 200 as const, body: {
        manager: {
          id: Number(entry),
          name: `${manager.player_first_name} ${manager.player_last_name}`.trim(),
          teamName: manager.name,
          overallPoints: Number(manager.summary_overall_points) || 0,
          overallRank: Number(manager.summary_overall_rank) || 0,
          gameweekPoints: Number(history.points) || 0,
          gameweekRank: Number(history.rank) || 0,
          squadValue: liveFinance
            ? liveFinance.squadValueMillions
            : Number(history.value)
              ? Number(history.value) / 10
              : null,
          bank: bankResolved.bank,
          bankSource: bankResolved.source,
          rankingFinance,
          publicHistoryBank,
          liveOverlayError: liveOverlayError ?? null,
          transfersMade: liveFinance ? liveFinance.transfersMade : Number(history.event_transfers) || 0,
          transferCost: liveFinance ? liveFinance.transferCost : Number(history.event_transfers_cost) || 0,
          // Official my-team FT allotment (null = WC/FH unlimited). Public history has no limit.
          freeTransferLimit: liveFinance ? liveFinance.freeTransferLimit : null,
          captainId: liveCaptain ?? captain?.element ?? null,
          viceCaptainId: liveVice ?? viceCaptain?.element ?? null,
          // Prefer live my-team chip (is_pending / legacy active); else public picks.active_chip.
          // Public active_chip is OK without overlay — already public. Pending WC before
          // deadline only appears on authenticated my-team (activation is on official FPL).
          chip: resolveManagerActiveChip({
            liveActiveChip: liveFinance?.activeChip,
            publicActiveChip: typeof picks.active_chip === "string" ? picks.active_chip : null,
          }),
          event: event.id,
          picks: responsePicks,
        },
        event: event.id,
        playerIds: ownedIds,
        liveOverlay: Boolean(liveFinance),
        liveOverlayError: liveOverlayError ?? null,
        rankingFinance,
        publicHistoryBank,
    } };
  }
  return {
    status: 409 as const,
    body: {
      error:
        "FPL only makes a manager's current squad public after the first deadline. Until then, build it manually and save it here.",
    },
  };
}
