import { getCurrentUser } from "../../../lib/auth";
import { readRuntimeEnv } from "../../../lib/runtime-env";
import { evaluateBotOwnerGate } from "../../../lib/fpl-bot/config";
import { botDb } from "../../../lib/fpl-bot/d1";
import { readBotStatus } from "../../../lib/fpl-bot/status";
import type { FplEvent } from "../../../lib/fpl";

/**
 * Owner-only bot status (mode, session age, last/next run, recent decisions, errors). Pure read: no writes, no token
 * refresh, no FPL authenticated call (the cron owns all of that). Never returns token material.
 */
export async function GET() {
  const env = await readRuntimeEnv();
  const user = await getCurrentUser();
  const gate = evaluateBotOwnerGate(env, user?.email ?? null);
  if (!gate.ok) return Response.json({ ok: false, error: gate.reason }, { status: gate.reason === "unauthenticated" ? 401 : 403, headers: { "Cache-Control": "no-store" } });
  let events: FplEvent[] | null = null;
  try {
    const response = await fetch("https://fantasy.premierleague.com/api/bootstrap-static/", { headers: { Accept: "application/json", "User-Agent": "FPL-Edge/1.0" }, next: { revalidate: 300 } } as RequestInit);
    if (response.ok) events = (((await response.json()) as { events?: Record<string, unknown>[] }).events ?? []).map((e) => ({
      id: Number(e.id),
      name: String(e.name ?? ""),
      deadline: String(e.deadline_time ?? ""),
      current: e.is_current === true,
      next: e.is_next === true,
      finished: e.finished === true,
      dataChecked: e.data_checked === true,
    }));
  } catch {
    events = null;
  }
  try {
    const status = await readBotStatus(await botDb(), env, events, Date.now());
    return Response.json({ ok: true, status }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false, error: "status-unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
