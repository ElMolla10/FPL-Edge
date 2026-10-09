/**
 * Deadline-relative schedule, evaluated on every hourly cron tick (the Worker keeps ONE "0 * * * *" cron so the
 * heavy ranking keeps the >= 1 h cron CPU class). Deadlines always come from the live events list, never hard-coded.
 *
 *   m = minutes until the next deadline at this tick
 *   m > 26 h            idle
 *   180 < m <= 26 h     plan        (full ranking, logged; no writes)
 *   70 < m <= 180       submit      (chip + transfers, then lineup; verify)
 *   25 <= m <= 70       final       (submit if still pending/retryable, then lineup/captain re-check from late news)
 *   m < 25              locked      (read-only; unsent steps are marked missed; FPL keeps the saved team)
 *
 * With :00 deadlines the ticks are D-3h / D-2h (submit, one retry) and D-1h (final). With :30 deadlines: D-2.5h,
 * D-1.5h (submit) and D-30m (final).
 */
import type { FplEvent } from "../fpl";

export type ScheduleWindow = "idle" | "plan" | "submit" | "final" | "locked" | "no-event";

export const WINDOW_MINUTES = Object.freeze({ plan: 26 * 60, submit: 180, final: 70, lock: 25 });

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
  if (m <= WINDOW_MINUTES.final) return "final";
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
