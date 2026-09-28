import { FplData, FplPlayer, futureEvents, isCompleteSquad, playerProjection } from "./fpl";

export const EXAMPLE_SQUAD_FLAG_KEY = "fpl-edge-example-squad";
export const EXAMPLE_SQUAD_LABEL = "Example squad — not your FPL team";

/** True when the desk is showing the labelled visitor demo squad. */
export function isExampleSquadActive(): boolean {
  try {
    return localStorage.getItem(EXAMPLE_SQUAD_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearExampleSquadFlag(): void {
  try {
    localStorage.removeItem(EXAMPLE_SQUAD_FLAG_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Build a legal 15-player demo squad from live FPL data (budget + club limit).
 * Prefers high next-GW xPts within each position quota — not a static ID list that goes stale.
 */
export function buildExampleSquad(data: FplData): FplPlayer[] {
  const event = futureEvents(data, 1)[0];
  const first = event?.id ?? data.events.find((e) => !e.finished)?.id ?? 1;
  const score = (p: FplPlayer) => playerProjection(p, first, data.fixtures, first);
  const budget = data.rules.budget;
  const teamLimit = data.rules.teamLimit;
  const squad: FplPlayer[] = [];
  const clubs = new Map<number, number>();
  let spent = 0;

  for (const rule of data.rules.positions) {
    const pool = data.players
      .filter((p) => p.positionId === rule.id && p.status !== "u" && p.chance !== 0)
      .sort((a, b) => score(b) - score(a) || a.price - b.price);
    for (const player of pool) {
      if (squad.filter((p) => p.positionId === rule.id).length >= rule.squad) break;
      if (squad.some((p) => p.id === player.id)) continue;
      if ((clubs.get(player.teamId) ?? 0) >= teamLimit) continue;
      const remainingSlots = data.rules.squadSize - squad.length - 1;
      // Leave ~£4.0m per remaining empty slot so later positions still fit.
      if (spent + player.price + remainingSlots * 4.0 > budget + 0.05) continue;
      squad.push(player);
      clubs.set(player.teamId, (clubs.get(player.teamId) ?? 0) + 1);
      spent += player.price;
    }
  }

  if (!isCompleteSquad(squad, data)) {
    // Fallback: cheapest legal fill per position (always fits budget on a normal FPL pool).
    const cheap: FplPlayer[] = [];
    const cheapClubs = new Map<number, number>();
    for (const rule of data.rules.positions) {
      const pool = data.players
        .filter((p) => p.positionId === rule.id && p.status !== "u")
        .sort((a, b) => a.price - b.price || score(b) - score(a));
      for (const player of pool) {
        if (cheap.filter((p) => p.positionId === rule.id).length >= rule.squad) break;
        if (cheap.some((p) => p.id === player.id)) continue;
        if ((cheapClubs.get(player.teamId) ?? 0) >= teamLimit) continue;
        cheap.push(player);
        cheapClubs.set(player.teamId, (cheapClubs.get(player.teamId) ?? 0) + 1);
      }
    }
    return cheap;
  }
  return squad;
}

/** Persist example squad locally for visitors (no account write). Returns false if incomplete. */
export function activateExampleSquad(data: FplData): boolean {
  const squad = buildExampleSquad(data);
  if (!isCompleteSquad(squad, data)) return false;
  try {
    localStorage.setItem("fpl-edge-squad", JSON.stringify(squad.map((p) => p.id)));
    localStorage.setItem(EXAMPLE_SQUAD_FLAG_KEY, "1");
    localStorage.removeItem("fpl-edge-manager");
    localStorage.removeItem("fpl-edge-entry");
    localStorage.setItem("fpl-edge-free-transfers", "1");
    return true;
  } catch {
    return false;
  }
}
