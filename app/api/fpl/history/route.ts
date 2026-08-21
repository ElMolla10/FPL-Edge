const FPL = "https://fantasy.premierleague.com/api";

export async function GET(request: Request) {
  const entry = new URL(request.url).searchParams.get("entry")?.trim();
  if (!entry || !/^\d+$/.test(entry)) return Response.json({ error: "Enter a valid numeric FPL manager ID." }, { status: 400 });
  try {
    const headers = { Accept: "application/json", "User-Agent": "FPL-Edge/1.0" };
    const [entryResponse, historyResponse, bootstrapResponse] = await Promise.all([
      fetch(`${FPL}/entry/${entry}/`, { headers, next: { revalidate: 300 } }),
      fetch(`${FPL}/entry/${entry}/history/`, { headers, next: { revalidate: 300 } }),
      fetch(`${FPL}/bootstrap-static/`, { headers, next: { revalidate: 300 } }),
    ]);
    if (!entryResponse.ok || !historyResponse.ok || !bootstrapResponse.ok) throw new Error("Manager not found or official FPL history is unavailable.");
    const [manager, history, bootstrap] = await Promise.all([entryResponse.json(), historyResponse.json(), bootstrapResponse.json()]);
    const playerNames = new Map(bootstrap.elements.map((p: any) => [p.id, p.web_name]));
    const completed = history.current.filter((week: any) => bootstrap.events.find((event: any) => event.id === week.event)?.finished);
    const weeks = await Promise.all(completed.map(async (week: any) => {
      const [picksResponse, liveResponse] = await Promise.all([
        fetch(`${FPL}/entry/${entry}/event/${week.event}/picks/`, { headers, next: { revalidate: 300 } }),
        fetch(`${FPL}/event/${week.event}/live/`, { headers, next: { revalidate: 300 } }),
      ]);
      if (!picksResponse.ok || !liveResponse.ok) return { ...week, unavailable: true };
      const [picks, live] = await Promise.all([picksResponse.json(), liveResponse.json()]);
      const points = new Map(live.elements.map((element: any) => [element.id, Number(element.stats?.total_points) || 0]));
      const captain = picks.picks.find((pick: any) => pick.is_captain);
      const vice = picks.picks.find((pick: any) => pick.is_vice_captain);
      const captainRaw = Number(points.get(captain?.element)) || 0;
      return {
        event: week.event,
        points: week.points,
        totalPoints: week.total_points,
        overallRank: week.overall_rank,
        gameweekRank: week.rank,
        transfers: week.event_transfers,
        transferCost: week.event_transfers_cost,
        pointsOnBench: week.points_on_bench,
        value: week.value / 10,
        bank: week.bank / 10,
        captain: playerNames.get(captain?.element) || "—",
        captainRawPoints: captainRaw,
        captainContribution: captainRaw * (captain?.multiplier || 0),
        viceCaptain: playerNames.get(vice?.element) || "—",
        chip: picks.active_chip || null,
      };
    }));
    return Response.json({
      updatedAt: new Date().toISOString(),
      manager: { id: Number(entry), name: `${manager.player_first_name} ${manager.player_last_name}`.trim(), teamName: manager.name, overallPoints: manager.summary_overall_points, overallRank: manager.summary_overall_rank },
      weeks,
    }, { headers: { "Cache-Control": "private, max-age=300" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not load official FPL history." }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
