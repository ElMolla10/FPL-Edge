/** Authenticated GET /api/my-team/{entry}/ (2025/26+ shape; same fields the personal overlay already relies on). */
export type BotMyTeamPick = {
  element: number;
  position: number;
  selling_price: number;
  purchase_price: number;
  is_captain: boolean;
  is_vice_captain: boolean;
  multiplier: number;
};

export type BotMyTeamChip = {
  name?: string | null;
  status_for_entry?: string | null;
  is_pending?: boolean | null;
  start_event?: number | null;
  stop_event?: number | null;
  chip_type?: string | null;
  number?: number | null;
  played_by_entry?: readonly number[] | null;
};

export type BotMyTeam = {
  picks: BotMyTeamPick[];
  transfers: { bank: number; limit: number | null; made: number; value?: number; cost?: number; status?: string };
  chips?: BotMyTeamChip[];
};

export type OfficialChip = "wildcard" | "freehit" | "bboost" | "3xc";
export const OFFICIAL_CHIPS: readonly OfficialChip[] = ["wildcard", "freehit", "bboost", "3xc"];
