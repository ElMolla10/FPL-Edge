const FPL = "https://fantasy.premierleague.com/api";

export async function GET(request: Request) {
  const entry = new URL(request.url).searchParams.get("entry")?.trim();
  if (!entry || !/^\d+$/.test(entry)) return Response.json({ error: "Enter a valid numeric FPL Team ID." }, { status: 400 });
  try {
    const headers = { Accept: "application/json", "User-Agent": "FPL-Edge/1.0" };
    const [managerResponse, bootstrapResponse] = await Promise.all([
      fetch(`${FPL}/entry/${entry}/`, { headers, next: { revalidate: 300 } }),
      fetch(`${FPL}/bootstrap-static/`, { headers, next: { revalidate: 300 } }),
    ]);
    if (!managerResponse.ok || !bootstrapResponse.ok) throw new Error("That FPL Team ID was not found.");
    const [manager, bootstrap] = await Promise.all([managerResponse.json(), bootstrapResponse.json()]);
    const candidateEvents = bootstrap.events.filter((event: any) => event.finished || event.is_current || (event.is_next && Date.parse(event.deadline_time) <= Date.now())).sort((a: any,b: any)=>b.id-a.id);
    for (const event of candidateEvents) {
      const picksResponse = await fetch(`${FPL}/entry/${entry}/event/${event.id}/picks/`, { headers, next: { revalidate: 300 } });
      if (!picksResponse.ok) continue;
      const picks = await picksResponse.json();
      const history = picks.entry_history || {};
      const captain = picks.picks.find((pick: any) => pick.is_captain);
      const viceCaptain = picks.picks.find((pick: any) => pick.is_vice_captain);
      return Response.json({
        manager: {
          id: Number(entry),
          name: `${manager.player_first_name} ${manager.player_last_name}`.trim(),
          teamName: manager.name,
          overallPoints: Number(manager.summary_overall_points) || 0,
          overallRank: Number(manager.summary_overall_rank) || 0,
          gameweekPoints: Number(history.points) || 0,
          gameweekRank: Number(history.rank) || 0,
          squadValue: Number(history.value) ? Number(history.value) / 10 : null,
          bank: Number.isFinite(Number(history.bank)) ? Number(history.bank) / 10 : null,
          transfersMade: Number(history.event_transfers) || 0,
          transferCost: Number(history.event_transfers_cost) || 0,
          captainId: captain?.element || null,
          viceCaptainId: viceCaptain?.element || null,
          chip: picks.active_chip || null,
        },
        event: event.id,
        playerIds: picks.picks.map((pick: any) => pick.element),
      }, { headers: { "Cache-Control": "private, max-age=300" } });
    }
    return Response.json({ error: "FPL only makes a manager's current squad public after the first deadline. Until then, build it manually and save it here." }, { status: 409 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not import that FPL team." }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
