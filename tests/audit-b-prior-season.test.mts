import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import snapshot from "../app/data/prior-season-2025-26.json" with { type: "json" };
import { PRIOR_SEASON_COLUMNS, decodePriorSeason } from "../app/lib/prior-season.ts";

// Digest of the pre-compaction verbose snapshot (461 players, all 11 fields the route reads).
const original = { count: 461, digest: 2107394 };

test("compact prior-season snapshot decodes to the exact fields the route uses", () => {
  const decoded = decodePriorSeason(snapshot as never);
  assert.equal(decoded.season, "2025/26");
  assert.equal(decoded.competition, "Premier League");
  assert.equal(decoded.players.length, snapshot.players.length);
  assert.ok(decoded.players.length > 400);
  for (const player of decoded.players) {
    assert.deepEqual(Object.keys(player).sort(), ["season", ...PRIOR_SEASON_COLUMNS].sort());
    for (const column of PRIOR_SEASON_COLUMNS) assert.ok(Number.isFinite(player[column]), `${column} finite`);
  }
  const ids = decoded.players.map((p) => p.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.equal(new Set(ids).size, ids.length);
});

test("decoded values equal the previous verbose snapshot for every player (spot-checked by digest)", () => {
  const decoded = decodePriorSeason(snapshot as never);
  assert.equal(decoded.players.length, original.count);
  let sum = 0;
  for (const p of decoded.players) sum += p.id * 7 + p.code % 1013 + p.totalPoints * 3 + p.minutes + p.starts * 5 + p.bonus * 11 + p.saves + p.penaltiesSaved * 13 + p.defensiveContribution + Math.round(p.expectedGoals * 100) + Math.round(p.expectedAssists * 100);
  assert.equal(sum, original.digest);
});

test("sync script columns match the decoder columns and route no longer imports the verbose JSON shape", () => {
  const script = readFileSync(new URL("../scripts/sync-prior-season.mjs", import.meta.url), "utf8");
  const match = /const COLUMNS = \[([^\]]+)\]/.exec(script);
  assert.ok(match);
  const columns = match[1].split(",").map((c) => c.trim().replace(/"/g, ""));
  assert.deepEqual(columns, [...PRIOR_SEASON_COLUMNS]);
  assert.deepEqual(snapshot.columns, [...PRIOR_SEASON_COLUMNS]);
  const route = readFileSync(new URL("../app/api/fpl/route.ts", import.meta.url), "utf8");
  assert.match(route, /decodePriorSeason\(priorSeasonData\)/);
});
