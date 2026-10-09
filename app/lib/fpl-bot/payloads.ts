/**
 * Builders for the two FPL write payloads. Pure: they return plain objects and never import fetch.
 *
 *   POST /api/transfers/         { chip: null|"wildcard"|"freehit", entry, event, transfers: [{element_in, element_out,
 *                                  purchase_price, selling_price}], confirmed: true }
 *   POST /api/my-team/{entry}/   { picks: [{element, position, is_captain, is_vice_captain} x15], chip: null|"bboost"|"3xc" }
 *
 * Prices are FPL tenths: purchase_price = the incoming player's CURRENT now_cost, selling_price = my-team's
 * selling_price for the outgoing pick (never a derived estimate).
 */
import type { BotMyTeam } from "./types";
import type { ElementInfo } from "./validate";

export type TransferLegPayload = { element_in: number; element_out: number; purchase_price: number; selling_price: number };
export type TransferChip = null | "wildcard" | "freehit";
export type PickChip = null | "bboost" | "3xc";

export type TransfersPayload = {
  chip: TransferChip;
  entry: number;
  event: number;
  transfers: TransferLegPayload[];
  confirmed: true;
};

export type PickPayload = { element: number; position: number; is_captain: boolean; is_vice_captain: boolean };
export type PicksPayload = { picks: PickPayload[]; chip: PickChip };

export type PlannedLeg = { outId: number; inId: number };

export function buildTransfersPayload(args: {
  entry: string;
  event: number;
  legs: readonly PlannedLeg[];
  myTeam: BotMyTeam;
  elements: ReadonlyMap<number, ElementInfo>;
  chip: TransferChip;
}): TransfersPayload {
  const transfers = args.legs.map((leg) => {
    const outPick = args.myTeam.picks.find((pick) => pick.element === leg.outId);
    if (!outPick) throw new Error(`player ${leg.outId} is not in the bot squad`);
    const incoming = args.elements.get(leg.inId);
    if (!incoming) throw new Error(`player ${leg.inId} is unknown`);
    return { element_in: leg.inId, element_out: leg.outId, purchase_price: incoming.nowCost, selling_price: outPick.selling_price };
  });
  return { chip: args.chip, entry: Number(args.entry), event: args.event, transfers, confirmed: true };
}

export type PlannedLineup = {
  /** 11 starters (any order; GK is placed at position 1). */
  starters: readonly number[];
  /** Bench: [benchGK, outfield1, outfield2, outfield3] in autosub priority. */
  bench: readonly number[];
  captainId: number;
  viceId: number;
};

/** Positions: 1 = starting GK, 2..11 outfield starters ordered DEF, MID, FWD; 12 = bench GK; 13..15 bench order. */
export function buildPicksPayload(lineup: PlannedLineup, elements: ReadonlyMap<number, ElementInfo>, chip: PickChip): PicksPayload {
  const pos = (id: number) => elements.get(id)?.positionId ?? 99;
  const starters = [...lineup.starters].sort((a, b) => pos(a) - pos(b) || a - b);
  const ordered = [...starters, ...lineup.bench];
  return {
    picks: ordered.map((element, index) => ({
      element,
      position: index + 1,
      is_captain: element === lineup.captainId,
      is_vice_captain: element === lineup.viceId,
    })),
    chip,
  };
}

/** The same 15 picks as currently saved on FPL, in payload form (for compare-before-POST). */
export function picksFromMyTeam(myTeam: BotMyTeam): PickPayload[] {
  return [...myTeam.picks]
    .sort((a, b) => a.position - b.position)
    .map((pick) => ({ element: pick.element, position: pick.position, is_captain: pick.is_captain, is_vice_captain: pick.is_vice_captain }));
}
