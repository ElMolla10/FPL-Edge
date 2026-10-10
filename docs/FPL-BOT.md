# FPL Edge autonomous bot

The bot manages **its own, separate FPL team**: transfers (including a bounded hit policy), starting XI, bench order,
captain / vice, and all four chips (Wildcard, Free Hit, Bench Boost, Triple Captain). It runs inside the existing
hourly Worker cron, using the same engine as the site (`rankTransfersForBestDecision`, Draft Lab / Wildcard optimiser,
chip scores + chip portfolio scheduler, bench order, captaincy).

> **Terms of Service.** FPL's terms (28(d)) prohibit automated access. The owner accepted this risk for a dedicated
> bot account. The bot never touches the owner's personal team (enforced in code and tests, see "Separation").

## Modes

| mode | what happens |
|---|---|
| `off` | nothing (hourly heartbeat only) |
| `shadow` (default) | full plan every GW, logged to `bot_decisions` / `bot_runs`, **no POST** |
| `live` | the same plan is validated and POSTed to FPL, then verified from `my-team` |

Requested mode = the setting on `/bot` if the owner chose one, else `FPL_EDGE_BOT_MODE`, else `shadow`.
`FPL_EDGE_BOT_MODE=off` is a hard ops kill the page cannot override. **Live is only effective when** the bot entry id
is set (and differs from the personal entry), the stored token's `/api/me` entry equals the bot entry, and a dry run
passed for that entry. Anything missing silently drops to `shadow`; the kill switch drops to `off`.

## Schedule (deadline-relative, hourly cron `0 * * * *`)

| minutes to deadline | window | action |
|---|---|---|
| > 24 h | idle | heartbeat, token keep-alive, dry run if pending |
| 24 h - 4 h | plan | shadow plan logged (what it intends to do); no transfer POST |
| 4 h - 85 min | submit | live: transfers (+WC/FH) ONCE while >= 2 h remain, rebuilt from fresh availability; then lineup / captain (+BB/TC) |
| 85 - 25 min | final | live: the last tick before lock re-picks lineup / captain with the latest flags; late news may only cancel BB/TC |
| < 25 min | locked | nothing; unfinished steps marked missed (FPL keeps the saved team) |

**Transfer timing (hard rule):** a transfers POST is only allowed between deadline-24h and deadline-2h
(`transferPostAllowed`, checked when choosing the step AND again right before the POST). With :00 deadlines the bot
submits at D-4h (retries D-3h, D-2h); with :30 deadlines at D-3.5h (retry D-2.5h). Lineup / captain may still change
later, and the final window (60 min wide) guarantees one re-pick at the last hourly tick before lock. No POST is ever
sent within 5 minutes of the deadline.

## Safety rails

- **Idempotent steps**: `bot_runs` has one row per (entry, GW, step); a step is claimed with a lease and runs once.
  Intent is persisted as `posted` **before** a transfer POST; a crash/timeout is resolved next tick by comparing
  `my-team` to the target squad hash, never by re-posting. Ambiguous outcome => GW kill switch + alert.
- **Pre-POST validation** (`validate.ts`, pure): 15 players, 2/5/5/3, max 3 per club, budget with my-team selling
  prices and fresh `now_cost`, same-position legs, incoming not unavailable / 0%, legal formation, GK slots,
  captain + vice in the XI and not flagged out, one chip per GW, chip windows, FH never GW1, deadline guard.
- **Post-submit verification**: re-read `my-team`; mismatch => GW kill switch + alert.
- **Hits**: default at most **one -4 per GW**, only when the engine's risk-adjusted 5-GW net vs HOLD clears the hit
  MAKE threshold **+1.0**; max 8 hit points over 4 GWs. `FPL_EDGE_BOT_HIT_POLICY=none|max1|max2`.
- **Chips**: `FPL_EDGE_BOT_CHIP_POLICY=all` (default) | `cancellable` (BB/TC only) | `none`.
- **Rate caps**: <= 12 authenticated FPL calls per tick, 1.5 s + jitter spacing, <= 4 POSTs per GW, <= 6 per UTC day,
  429 / 5xx => stop for this tick.
- **Kill switches**: global (page or `FPL_EDGE_BOT_MODE=off`), per-GW (set automatically on mismatch / ambiguity).
- **Do-nothing fallback**: any auth / data / validation / cap doubt => no POST, logged reason; FPL keeps the last team.
- **Wrong-account rejection**: the reconnect route checks `/api/me` with the new access token **before storing**;
  the cron re-checks every 24 h and sets the kill switch if the token belongs to another team.
- **Session age**: PingOne sessions end ~30 days after the interactive sign-in. Alert from **day 20**; from day 28
  the bot skips transfers (lineup only) so it never leaves a half-applied plan.

## Separation from the personal account

- Own D1 tables (`bot_*`, migration `0012_fpl_bot.sql`), own AES-GCM key (`FPL_EDGE_BOT_TOKEN_KEY`), own owner
  allowlist (`FPL_EDGE_BOT_OWNER_EMAILS`).
- Bot code imports only the **pure** helpers from `personal-fpl-transfer` (OIDC refresh, rotating provider, refresh-token
  parsing, free-transfer maths). It never imports the personal store / keep-alive / live-team, never reads the personal
  refresh token, and reads `FPL_EDGE_PERSONAL_FPL_ENTRY_ID` only to assert the bot entry is different.
  `tests/fpl-bot-separation.test.mts` enforces all of this.
- Every FPL URL / payload goes through `assertBotEntry`; the client refuses POSTs unless the runner arms it right
  before a validated live write, and refuses a transfer payload for any other entry.

## Configuration

| variable | purpose |
|---|---|
| `FPL_EDGE_BOT_FPL_ENTRY_ID` | the bot team's entry id (secret; never committed) |
| `FPL_EDGE_BOT_TOKEN_KEY` | 32-byte base64 AES key for token encryption (`openssl rand -base64 32`) |
| `FPL_EDGE_BOT_OWNER_EMAILS` | comma-separated Edge accounts allowed on `/bot` |
| `FPL_EDGE_BOT_MODE` | optional `off` / `shadow` / `live` (page setting wins unless env is `off`) |
| `FPL_EDGE_BOT_TEAM_NAME` | optional: reconnect refuses if the bot team's public name differs |
| `FPL_EDGE_BOT_HIT_POLICY` | optional `none` / `max1` (default) / `max2` |
| `FPL_EDGE_BOT_CHIP_POLICY` | optional `all` (default) / `cancellable` / `none` |
| `FPL_EDGE_BOT_FPL_REFRESH_TOKEN` | optional one-time seed instead of the bookmarklet |

### Workers plan / cron

- The cron trigger already exists (`"crons": ["0 * * * *"]`); no new trigger is needed.
- Planning runs the optimiser in the cron (seconds of CPU), so the bot needs **Workers Paid** (the Free plan allows
  ~10 ms CPU per invocation). The account is on Workers Paid and `wrangler.jsonc` sets `"limits": { "cpu_ms": 120000 }`
  (2 min, matching the planner's `BOT_PLAN_TIME_BUDGET_MS`), which the build carries into `dist/server/wrangler.json`.
  The bot's work runs in its own `ctx.waitUntil` job, so a CPU-limit kill only affects the bot tick (the step stays
  claimed/retryable; no POST is half-sent because intent is persisted first).
- Apply migration `0012_fpl_bot.sql` (`wrangler d1 migrations apply`) before deploying.

## New team before its first deadline

A team created mid-season has unlimited free transfers until its first deadline. The bot detects this from
authenticated data only: `my-team` reports `transfers.limit === null`, no chip is pending, and the public entry's
`started_event` equals the next event. In that state the bot rebuilds the best 15 on its real budget (Draft Lab / Wildcard
optimiser over fully available players only: status `a`, chance >= 75), sends the needed legs in one transfers POST
with `chip: null` and no hit, then sets the XI, captain and vice. It may submit as soon as the plan window opens
(24 h before the deadline) instead of waiting for the submit window. Post-submit verification requires 0 points
deducted (`spent_points` in the response when present, else `my-team`). From the next gameweek, normal rules apply.

The bot reads its team only from the authenticated `my-team` endpoint, never the public picks endpoint (a new team has
none before its first deadline).

## Operator trigger

`POST /__bot/run` with `Authorization: Bearer <FPL_EDGE_BOT_TRIGGER_SECRET>` and `{"action": "inspect" | "rehearse" |
"tick"}`. `rehearse` also accepts `"event": <id>` and `"simulateFreeTransfers": <n>` to rehearse a later gameweek
(earlier events are treated as finished; the my-team transfer limit is replaced by the simulated one, clearly marked
`simulated` in the response). `inspect` and `rehearse` are read-only (my-team shape, full plan, payloads and validation). `tick` runs exactly
the hourly cron tick with all its rails. The path returns 404 unless the secret (>= 32 chars) is set.

## Connecting the bot account (owner)

1. Create the bot FPL account and team. FPL has **no API for creating a team's first squad**; `/bot` ->
   "Build suggested squad" gives Edge's Draft Lab best 15 to enter by hand.
2. Set the secrets: `FPL_EDGE_BOT_FPL_ENTRY_ID`, `FPL_EDGE_BOT_TOKEN_KEY`, `FPL_EDGE_BOT_OWNER_EMAILS`
   (optionally `FPL_EDGE_BOT_TEAM_NAME`).
3. In a **separate browser profile**, sign in to fantasy.premierleague.com **as the bot**, then click the bookmarklet
   copied from `/bot`. It hands the session to `/bot#bot_rt=...`, the page strips it from the URL and POSTs it to
   `/api/bot/fpl-auth/reconnect`, which verifies `/api/me` == bot entry before storing anything.

   **One session, one holder.** PingOne rotates the refresh token on every use and treats reuse of a spent one as
   theft: it revokes the whole token family. The reconnect exchanges the browser's refresh token once (rotation), so
   the copy still in the FPL tab is spent. If that browser later renews with it (any FPL tab or a later visit to FPL in
   that profile), the bot's session dies within the hour. The bookmarklet therefore deletes the `oidc.user:*` entry from
   that browser after reading it. Close all other FPL tabs in that profile before clicking it, do **not** press Sign out
   afterwards (logout ends the PingOne session and its tokens), and do not open FPL in that profile again; just close
   the window. To look at the bot's team, use the public pages or Edge `/bot`.
4. The next hourly tick verifies identity and runs the dry run (read-only rehearsal of the full submit path).
5. Watch a shadow gameweek on `/bot`, then press "Go live" (or set `FPL_EDGE_BOT_MODE=live`).
6. Repeat step 3 about every three weeks (status + alert from day 20).

Auth failures store a token-free detail (OIDC status, code and PingOne's description) in `bot_errors.detail`, so a
revoked family can be told apart from a network failure. Workers Logs are enabled (`observability` in `wrangler.jsonc`).

Alerts are written to `bot_errors` (shown on `/bot`) and logged with the `[fpl-bot] ALERT` prefix for Workers Logs;
there is no e-mail channel on `main` yet.
