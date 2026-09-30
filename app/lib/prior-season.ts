// Compact prior-season snapshot codec.
//
// `app/data/prior-season-2025-26.json` stores only the fields the projection
// engine reads, as column-ordered tuples (see `scripts/sync-prior-season.mjs`),
// so the worker bundle does not carry ~460 verbose objects. `decodePriorSeason`
// rebuilds the exact record shape `/api/fpl` used before the compaction.

export const PRIOR_SEASON_COLUMNS = [
  "id",
  "code",
  "totalPoints",
  "minutes",
  "starts",
  "expectedGoals",
  "expectedAssists",
  "bonus",
  "saves",
  "penaltiesSaved",
  "defensiveContribution",
] as const;

export type PriorSeasonColumn = (typeof PRIOR_SEASON_COLUMNS)[number];

export type PriorSeasonRecord = { season: string } & Record<PriorSeasonColumn, number>;

export type PriorSeasonSnapshot = {
  season: string;
  competition: string;
  generatedAt: string;
  source: string;
  columns: readonly string[];
  players: readonly (readonly number[])[];
};

export function decodePriorSeason(snapshot: PriorSeasonSnapshot): { season: string; competition: string; players: PriorSeasonRecord[] } {
  const indexes = PRIOR_SEASON_COLUMNS.map((column) => {
    const index = snapshot.columns.indexOf(column);
    if (index < 0) throw new Error(`prior-season snapshot is missing column ${column}`);
    return index;
  });
  const players = snapshot.players.map((row) => {
    const record: Record<string, number | string> = { season: snapshot.season };
    PRIOR_SEASON_COLUMNS.forEach((column, i) => {
      record[column] = row[indexes[i]];
    });
    return record as PriorSeasonRecord;
  });
  return { season: snapshot.season, competition: snapshot.competition, players };
}
