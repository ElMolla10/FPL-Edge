// Official FPL event deadlines, used only to place the season-pass window. A failed fetch
// returns [] so resolveSeasonWindow can fall back to SEASON_FALLBACK_END_ISO.

const BOOTSTRAP_URL = "https://fantasy.premierleague.com/api/bootstrap-static/";

export async function loadSeasonDeadlines(): Promise<{ deadline: string }[]> {
  try {
    const response = await fetch(BOOTSTRAP_URL, {
      headers: { Accept: "application/json", "User-Agent": "FPL-Edge/1.0" },
    });
    if (!response.ok) return [];
    const json = (await response.json()) as { events?: { deadline_time?: unknown }[] };
    return (json.events ?? [])
      .map((event) => ({ deadline: typeof event.deadline_time === "string" ? event.deadline_time : "" }))
      .filter((event) => event.deadline.length > 0);
  } catch {
    return [];
  }
}
