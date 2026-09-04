const FPL = "https://fantasy.premierleague.com/api";

// Deliberately narrow: /api/fpl/history already fetches entry/{id}/history/ but pays for a full
// per-completed-gameweek picks+live enrichment loop on top of it, just to build the History tab's
// weekly breakdown. This route exists because the chip portfolio only ever needs history.chips (a
// tiny, real, already-present array) -- reusing the heavier route for that would mean paying its
// full per-week fetch cost just to read four values.
export async function GET(request: Request) {
  const entry = new URL(request.url).searchParams.get("entry")?.trim();
  if (!entry || !/^\d+$/.test(entry)) return Response.json({ error: "Enter a valid numeric FPL Team ID." }, { status: 400 });
  try {
    const headers = { Accept: "application/json", "User-Agent": "FPL-Edge/1.0" };
    const historyResponse = await fetch(`${FPL}/entry/${entry}/history/`, { headers, next: { revalidate: 300 } });
    if (!historyResponse.ok) throw new Error("That FPL Team ID's chip history was not found.");
    const history = await historyResponse.json();
    return Response.json({
      chips: (history.chips ?? []).map((chip: any) => ({
        name: String(chip.name),
        event: Number(chip.event),
        time: String(chip.time),
      })),
    }, { headers: { "Cache-Control": "private, max-age=300" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not load official chip history." }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
