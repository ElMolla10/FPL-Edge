import { getCurrentUser } from "../../../lib/auth";
import { BodyError, isPlainObject, readJsonBody, rejectCrossSite } from "../../../lib/request-guards";
import { readRuntimeEnv } from "../../../lib/runtime-env";
import { BOT_ENV, botEntryId, evaluateBotOwnerGate, parseMode, resolveMode } from "../../../lib/fpl-bot/config";
import { botDb } from "../../../lib/fpl-bot/d1";
import { readBotAuthRow, readBotState, setBotKill, setBotMode, setGwKill } from "../../../lib/fpl-bot/store";

const ACTIONS = new Set(["kill", "resume", "clear-gw-kill", "mode"]);

/**
 * Owner-only bot control: kill switch, resume, per-GW kill clear, and the single "mode" switch (off | shadow | live |
 * follow-env). Going live is refused unless the bot entry is configured, the token's identity is verified and a dry
 * run passed. FPL_EDGE_BOT_MODE=off in the Worker env always wins (ops kill the page cannot override).
 * This route never talks to FPL and can never trigger a submission (only the cron writes to FPL).
 */
export async function POST(request: Request) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  const env = await readRuntimeEnv();
  const user = await getCurrentUser();
  const gate = evaluateBotOwnerGate(env, user?.email ?? null);
  if (!gate.ok) return Response.json({ ok: false, error: gate.reason }, { status: gate.reason === "unauthenticated" ? 401 : 403 });

  let body: Record<string, unknown>;
  try {
    const parsed = await readJsonBody(request);
    if (!isPlainObject(parsed)) return Response.json({ ok: false, error: "invalid-json" }, { status: 400 });
    body = parsed;
  } catch (error) {
    if (error instanceof BodyError) return Response.json({ ok: false, error: error.status === 413 ? "too-large" : "invalid-json" }, { status: error.status });
    return Response.json({ ok: false, error: "invalid-json" }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "";
  if (!ACTIONS.has(action)) return Response.json({ ok: false, error: "unknown-action" }, { status: 400 });

  const db = await botDb();
  const now = Date.now();
  if (action === "kill") {
    await setBotKill(db, true, "owner kill switch", now);
  } else if (action === "resume") {
    await setBotKill(db, false, null, now);
  } else if (action === "clear-gw-kill") {
    await setGwKill(db, null, null, now);
  } else {
    const raw = typeof body.mode === "string" ? body.mode : "";
    if (raw === "follow-env") {
      await setBotMode(db, null, now);
    } else {
      const mode = parseMode(raw);
      if (!mode) return Response.json({ ok: false, error: "unknown-mode" }, { status: 400 });
      if (mode === "live") {
        const state = await readBotState(db);
        const auth = await readBotAuthRow(db);
        const entry = botEntryId(env);
        const check = resolveMode({
          env: { ...env, [BOT_ENV.mode]: env[BOT_ENV.mode] === "off" ? "off" : "live" },
          storedMode: "live",
          kill: false,
          identityVerified: Boolean(entry && auth?.identity_entry === entry),
          dryRunPassed: Boolean(entry && state.dry_run_entry === entry && state.dry_run_passed_at),
        });
        if (check.effective !== "live") return Response.json({ ok: false, error: "live-not-ready", reasons: check.reasons }, { status: 409 });
      }
      await setBotMode(db, mode, now);
    }
  }
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
