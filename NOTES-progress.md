# feat/autonomous-bot — progress notes (survives interruption)

Worktree: /workspace/fpl-bot (branch feat/autonomous-bot off origin/main e8c6cf0).
Design source: /workspace/notes/FPL-EDGE-AUTONOMOUS-BOT-FEASIBILITY.md (Option A).

## Plan
- [ ] Extract best-decision.ts (same as feat/email-call-alerts) so the cron can run the engine
- [ ] migration 0012_fpl_bot.sql + db/schema tables (bot_fpl_auth, bot_state, bot_lock, bot_runs, bot_decisions)
- [ ] app/lib/fpl-bot: config, crypto, store, auth(keep-alive), fpl-client (GET/POST), validate, lineup, payloads, hash, schedule, policy (hits/chips), planner, runner
- [ ] worker scheduled() waitUntil
- [ ] routes: /api/bot/status (GET), /api/bot/kill (POST lower-only), /api/bot/fpl-auth/reconnect (POST), /api/bot/initial-squad (GET)
- [ ] owner page /bot
- [ ] tests (no POSTs to FPL)
- [ ] docs/FPL-BOT.md, SECURITY addendum
- [ ] draft PR

## Log
- best-decision.ts + chip-scores.ts extraction committed
- migration 0012_fpl_bot.sql + journal; app/lib/fpl-bot/{config,crypto,store,types,fpl-client,payloads,validate,hash,schedule,planner,auth,runner}.ts written, tsc clean
- NEXT: worker scheduled() hook, runtime-env keys, routes (/api/bot/status, /api/bot/control, /api/bot/fpl-auth/reconnect), /bot page, tests, docs
