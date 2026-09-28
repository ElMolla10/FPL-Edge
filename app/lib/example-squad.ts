import { FplData, FplPlayer, futureEvents, isCompleteSquad, playerProjection } from "./fpl";

/** Flag: desk is showing the labelled visitor demo squad (not the real draft). */
export const EXAMPLE_SQUAD_FLAG_KEY = "fpl-edge-example-squad";
/** Isolated storage for demo XV ids — never written to fpl-edge-squad / account sync. */
export const EXAMPLE_SQUAD_IDS_KEY = "fpl-edge-example-squad-ids";
/** Real / manual draft key (account sync + Draft Lab save). */
export const REAL_SQUAD_KEY = "fpl-edge-squad";
export const EXAMPLE_SQUAD_LABEL = "Example squad — not your FPL team";

function parseIds(key: string): number[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(raw) ? raw.filter((id): id is number => typeof id === "number") : [];
  } catch {
    return [];
  }
}

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
    localStorage.removeItem(EXAMPLE_SQUAD_IDS_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Active squad ids for the desk: demo storage when the example flag is on, otherwise the real draft.
 * Opening demo never reads/writes REAL_SQUAD_KEY, so visitor manuals survive.
 */
export function readActiveSquadIds(): number[] {
  if (isExampleSquadActive()) {
    const demo = parseIds(EXAMPLE_SQUAD_IDS_KEY);
    if (demo.length) return demo;
  }
  return parseIds(REAL_SQUAD_KEY);
}

/** Real draft only — used by account sync so example players never upload. */
export function readRealSquadIds(): number[] {
  return parseIds(REAL_SQUAD_KEY);
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

/**
 * Persist example squad in isolated demo storage only.
 * Does NOT touch fpl-edge-squad, manager, entry, or account sync paths.
 * Returns false if incomplete or storage fails.
 */
export function activateExampleSquad(data: FplData): boolean {
  const squad = buildExampleSquad(data);
  if (!isCompleteSquad(squad, data)) return false;
  try {
    localStorage.setItem(EXAMPLE_SQUAD_IDS_KEY, JSON.stringify(squad.map((p) => p.id)));
    localStorage.setItem(EXAMPLE_SQUAD_FLAG_KEY, "1");
    // Demo FT default for transfer UI — does not clear real draft / manager / entry.
    if (localStorage.getItem("fpl-edge-free-transfers") === null) {
      localStorage.setItem("fpl-edge-free-transfers", "1");
    }
    return true;
  } catch {
    return false;
  }
}

/** Persist squad ids for the active desk mode (demo vs real). Demo never uses persist/sync. */
export function writeActiveSquadIds(ids: number[], opts?: { syncReal?: (key: string, value: string) => void }): void {
  if (isExampleSquadActive()) {
    localStorage.setItem(EXAMPLE_SQUAD_IDS_KEY, JSON.stringify(ids));
    return;
  }
  const value = JSON.stringify(ids);
  if (opts?.syncReal) opts.syncReal(REAL_SQUAD_KEY, value);
  else localStorage.setItem(REAL_SQUAD_KEY, value);
}
