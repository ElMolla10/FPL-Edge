import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const FPL = "https://fantasy.premierleague.com/api";
const TARGET_SEASON = process.env.FPL_PRIOR_SEASON || "2025/26";
const OUTPUT = resolve("app/data/prior-season-2025-26.json");
const CONCURRENCY = 24;

async function getJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "FPL-Edge-Prior-Sync/1.0" },
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

const bootstrap = await getJson(`${FPL}/bootstrap-static/`);
const players = bootstrap.elements;
const records = new Array(players.length);
let cursor = 0;

async function worker() {
  while (cursor < players.length) {
    const index = cursor++;
    const player = players[index];
    const summary = await getJson(`${FPL}/element-summary/${player.id}/`);
    const prior = summary.history_past?.find((row) => row.season_name === TARGET_SEASON);
    if (!prior) continue;
    records[index] = {
      id: player.id,
      code: player.code,
      season: TARGET_SEASON,
      totalPoints: Number(prior.total_points) || 0,
      minutes: Number(prior.minutes) || 0,
      starts: Number(prior.starts) || 0,
      expectedGoals: Number(prior.expected_goals) || 0,
      expectedAssists: Number(prior.expected_assists) || 0,
      bonus: Number(prior.bonus) || 0,
      saves: Number(prior.saves) || 0,
      penaltiesSaved: Number(prior.penalties_saved) || 0,
      defensiveContribution: Number(prior.defensive_contribution) || 0,
      cleanSheets: Number(prior.clean_sheets) || 0,
      goalsConceded: Number(prior.goals_conceded) || 0,
      expectedGoalsConceded: Number(prior.expected_goals_conceded) || 0,
    };
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
const data = {
  season: TARGET_SEASON,
  competition: "Premier League",
  generatedAt: new Date().toISOString(),
  source: `${FPL}/element-summary/{element_id}/`,
  players: records.filter(Boolean).sort((a, b) => a.id - b.id),
};

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(data, null, 2)}\n`);
console.log(`Saved ${data.players.length}/${players.length} official ${TARGET_SEASON} Premier League priors to ${OUTPUT}`);
