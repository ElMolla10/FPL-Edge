/**
 * Deadline-relative schedule, evaluated on every hourly cron tick (the Worker keeps ONE "0 * * * *" cron so the
 * heavy ranking keeps the >= 1 h cron CPU class). Deadlines always come from the live events list, never hard-coded.
 *
 *   m = minutes until the next deadline at this tick
 *   m > 24 h            idle
 *   240 < m <= 24 h     plan        (full ranking, logged; no transfer POST - except a new team before its first
 *                                    deadline, which may be built here)
 *   85 <= m <= 240      submit      (transfers + chip ONCE while m >= 120, then lineup/captain; verify)
 *   25 <= m < 85        final       (the last hourly tick before lock: lineup/captain re-pick from late news)
 *   m < 25              locked      (read-only; unsent steps are marked missed; FPL keeps the saved team)
 *
 * Transfer POSTs are only ever allowed with 120 <= m <= 24 h (transferPostAllowed), and never inside the 5-minute
 * freeze. With :00 deadlines the transfer ticks are D-4h / D-3h / D-2h (first one submits, the others are retries);
 * with :30 deadlines D-3.5h / D-2.5h. The final window is 60 min wide so exactly one hourly tick always lands in it.
 */
import type { FplEvent } from "../fpl";

export type ScheduleWindow = "idle" | "plan" | "submit" | "final" | "locked" | "no-event";

export const WINDOW_MINUTES = Object.freeze({ plan: 24 * 60, submit: 240, final: 85, lock: 25 });
/** Transfer POSTs: never earlier than deadline-24h, never later than deadline-2h. */
export const TRANSFER_WINDOW_MINUTES = Object.freeze({ earliest: 24 * 60, latest: 120 });

export function nextDeadlineEvent(events: readonly FplEvent[], nowMs: number): FplEvent | null {
  return (
    [...events]
      .filter((event) => !event.finished && Number.isFinite(Date.parse(event.deadline)) && Date.parse(event.deadline) > nowMs)
      .sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline))[0] ?? null
  );
}

export function windowFor(deadlineMs: number, nowMs: number): ScheduleWindow {
  const m = (deadlineMs - nowMs) / 60_000;
  if (m < WINDOW_MINUTES.lock) return "locked";
  if (m < WINDOW_MINUTES.final) return "final";
  if (m <= WINDOW_MINUTES.submit) return "submit";
  if (m <= WINDOW_MINUTES.plan) return "plan";
  return "idle";
}

/** First top-of-hour tick at which the bot will next do something for this deadline (for the status page). */
export function nextActionTick(deadlineMs: number, nowMs: number): { atMs: number; window: ScheduleWindow } | null {
  const hour = 3_600_000;
  let tick = Math.floor(nowMs / hour) * hour + hour;
  for (let i = 0; i < 24 * 9; i++, tick += hour) {
    const window = windowFor(deadlineMs, tick);
    if (window === "locked") return null;
    if (window !== "idle") return { atMs: tick, window };
  }
  return null;
}

/** Hard gate for any transfers POST (normal gameweeks and a new team's first build alike). */
export function transferPostAllowed(deadlineMs: number, nowMs: number): boolean {
  const m = (deadlineMs - nowMs) / 60_000;
  return m <= TRANSFER_WINDOW_MINUTES.earliest && m >= TRANSFER_WINDOW_MINUTES.latest;
}
