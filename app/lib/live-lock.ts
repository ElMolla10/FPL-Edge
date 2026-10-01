// In-play view: deadline passed, event not finished. The locked plan (if any) is the source of truth
// for squad/XI/bench order/captain -- never localStorage edits made after the lock. Finished events
// stay on the History/audit path; this module returns null for them.
import type { FplEvent, FplPlayer } from "./fpl";

export type LiveLock = { event: number; xiIds: number[]; benchIds?: number[]; squadIds: number[]; captainId: number; viceId: number; predicted: number };

export function isLiveEvent(event: Pick<FplEvent, "deadline" | "finished"> | null | undefined, now = Date.now()): boolean {
  return !!event && !event.finished && Date.parse(event.deadline) <= now;
}

export function liveEvent<E extends Pick<FplEvent, "id" | "deadline" | "finished">>(events: readonly E[], now = Date.now()): E | null {
  return events.filter(e => isLiveEvent(e, now)).sort((a, b) => b.id - a.id)[0] ?? null;
}

/** The lock for a live event, or null. Never fabricated: no matching record → null. */
export function lockForLiveEvent<L extends { event: number }>(event: Pick<FplEvent, "id" | "deadline" | "finished"> | null | undefined, locks: readonly L[], now = Date.now()): L | null {
  if (!event || !isLiveEvent(event, now)) return null;
  return locks.find(l => l.event === event.id) ?? null;
}

/** Live points so far for a locked XI (captain doubled). Partial: no autosubs until every match finishes. */
export function lockedLiveSoFar(lock: LiveLock, players: readonly FplPlayer[]): number {
  const byId = new Map(players.map(p => [p.id, p]));
  const xi = lock.xiIds.map(id => byId.get(id)).filter((p): p is FplPlayer => !!p);
  const cap = xi.find(p => p.id === lock.captainId);
  return xi.reduce((s, p) => s + (p.eventPoints ?? 0), 0) + (cap?.eventPoints ?? 0);
}

export function readLocks<L = { event: number }>(): L[] {
  try { const v = JSON.parse(localStorage.getItem("fpl-edge-locks") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
