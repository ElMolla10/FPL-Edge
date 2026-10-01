# Email call alerts

Opt-in email (Resend only) when a signed-in manager's weekly call changes. No WhatsApp, Telegram, web push, SMS.
The feature is **inert** until two Worker secrets exist (see Go live).

## What is emailed

At most one email per user per UTC calendar day, except a second one (hard cap: 2) when a **new** official FPL flag
appears on a player in the saved 15 or on the recommended transfer target. Sent only if all hold:

1. signed in (account email), 2. `notify_call_changes = 1`, 3. a connected official FPL team (not the demo XV),
4. the canonical call hash changed since the last email we sent.

Body: the call (`HOLD` or `OUT → IN`), captain, one-line why, link to `https://…/?app=1`, and
"You can turn this off in account settings." Plain text + simple HTML, `List-Unsubscribe` header pointing at the app shell.

## The canonical call (server-side, shared code)

`app/lib/call-alerts/call.ts`, run hourly from `worker/index.ts` `scheduled()` in its own `waitUntil`.

hash = `sha256("v1;gw;decision;captainId;outId;inId;flagFingerprint")` (ids only; flag fingerprint = sorted `id:status:chance` tokens).

| Step | Shared code (same module the browser runs) |
|---|---|
| official squad, bank, selling prices, chip, FT | `buildTeamResponse` (`app/lib/team-response.ts`), extracted from `/api/fpl/team` with no behaviour change |
| finance (live bank only) | `deriveSandboxFinancialContext` + `isRankingFinanceUnavailable` — unavailable ⇒ user skipped and logged, **never** the public £2.1m fallback |
| ranking | `rankTransfersForBestDecision` → `bestTransfers(limit 60, deep)` → `withModelUtilityChange` (moved verbatim from `CoachCore.tsx` to `app/lib/best-decision.ts`; CoachCore re-exports it) |
| decision | `selectBestDecision` = the Transfers-surface **BEST DECISION**. LEAN counts as MAKE |
| captain | `resolveCaptaincy` (stored pick → official armband → model pick), identical to Overview |
| flags | `FplPlayer.status` / `chance` from the same `/api/fpl` snapshot (bootstrap-static + fixtures + live-event cache) |

**Decision choice (documented in code too):** where Home and Transfers could differ, the Transfers BEST DECISION wins; Overview's shallow
first paint is a budget-restricted preview and is not used. No third rule.

### Which squad
Real squad = a **connected FPL team id** (`squad_data.entry`). The cron re-reads the official picks for that entry (public FPL endpoints), so the
call reflects the live official XV, not a stale saved copy. Manual-only squads (no entry) have no official bank, the Transfers page refuses to rank them, so they are skipped ("no-connected-team").
The saved ids are only a gate: the demo XV (`buildExampleSquad`) is excluded even if it somehow reached the server.
The live "my team" overlay (real bank / selling prices) exists only for the allowlisted owner (`FPL_EDGE_PERSONAL_*`); everyone else uses the public entry-history bank,
exactly like the website. If the owner's live overlay is down, that user is skipped.

### Divergence risks vs the browser (honest list)
- **Free transfers**: the Transfers page lets a user pick FT in a localStorage selector; the server uses the live limit-minus-made when known, else **1** (the browser default).
- **Planned chips**: `readPlannedChips()` reads localStorage inside `transfers.ts`; on the server it sees `[]` (Worker has no `localStorage`).
  Only matters for users with a planned chip in the next 5 GWs.
- **Search budget**: the engine is wall-clock bounded (180 ms) in the browser; the cron passes `planTimeBudgetMs: 120000` so the deterministic node cap decides. The result can therefore
  differ in rare close calls from a slow phone. Repeat runs on the same data are identical (tested).
- **Captain**: the stored pick is the account-synced `captain_vice` for the first upcoming GW; a never-synced local pick is invisible to the server.
- A call that flips because the *browser* and the *server* disagree is not an alert; alerts fire only on server-vs-previous-server change.

## Cost / limits
Per user ≈ 2 official FPL requests + one deep ranking. A run evaluates ≤ 25 users (rotated by `last_checked_at`), sends sequentially with a 600 ms gap (Resend ≈ 2 req/s),
per-request timeouts (8 s FPL, 10 s Resend), and stops starting users after 10 min. A fatal Resend error (401/403/429) stops sending for the run; other failures are logged per user and the batch continues.
Writes (hash, `last_email_at`, counters) happen only after a successful send, so a failed send is retried next hour. **Deep ranking needs Workers Paid** (hourly cron: 15 min CPU; Free: 10 ms CPU).
No Queue is used; add one if opted-in users grow beyond a few hundred.

## Data model (`drizzle/0011_notification_prefs.sql`, applied by the deploy workflow)
`notification_prefs(user_id PK → users ON DELETE CASCADE, notify_call_changes default 0, last_call_hash, last_call_json [ids only], last_email_at,
emails_sent_utc_date, emails_sent_today, last_flag_fingerprint, last_checked_at, updated_at)` + a partial index on opted-in rows.

## Safety
- Settings write: `PUT /api/account/notifications` → CSRF (`rejectCrossSite`) → session cookie (#80, no header auth) → hand-rolled validator (exactly one boolean) → rate limit
  (10/h/user via the atomic `login_rate_limits` counter) → write. `GET` returns `{notifyCallChanges, hasConnectedTeam, email}` (default off).
- Demo (`?demo=1`, `fpl-edge-example-squad`): the checkbox is disabled; demo ids never sync to D1; the cron also excludes a saved squad equal to the example XV.
- FPL credentials are never requested or stored. Visitors and signed-out localStorage squads are never emailed (the cron only reads D1 accounts).
- The Resend base URL can be redirected only when `FPL_EDGE_DEV_MODE=1` **and** the URL is `http://127.0.0.1|localhost|[::1]`. Neither variable is in `wrangler.jsonc`; use `.dev.vars` (git-ignored).
- `RESEND_FROM` must be on a domain we control (workers.dev / pages.dev are rejected); with a bad or missing secret the cron no-ops and logs once.

## Privacy
Mail goes to the account email only, and the settings card shows the address ("Alerts go to …"; it is the user's own session). Resend is the only processor (the recipient address
and the email body are sent to it). Stored per user: opt-in flag, last-call hash (one-way), last call as player ids (no names), send timestamps/counters. Toggling off clears hash/ids/fingerprint
but keeps the daily counters (no cap bypass by toggling). There is no account-deletion feature today; `ON DELETE CASCADE` removes the row if one is added. The list is deliberately free of
tracking pixels, per-user tokens, and marketing.

## Go live (Mohamed)
1. Verify a sending domain in Resend (add the SPF/DKIM DNS records; `*.workers.dev` cannot send).
2. Create a Resend API key (sending access).
3. `wrangler secret put RESEND_API_KEY` and `wrangler secret put RESEND_FROM` (value e.g. `FPL Edge <alerts@yourdomain.tld>`).
4. Optional: `wrangler secret put FPL_EDGE_SITE_URL` (or a var) if the app gets a custom domain; default link host is `https://fpl-edge.elmolla10.workers.dev`.
5. Confirm the Worker is on the Paid plan. Deploy (the workflow applies migration 0011).
6. Opt in a test account in the app (More → "Email me if the weekly call changes.") and wait for the next `:00`.

## Test safely
`.dev.vars` (git-ignored): `RESEND_API_KEY=test`, `RESEND_FROM=FPL Edge <alerts@example.invalid>`, `FPL_EDGE_DEV_MODE=1`, `FPL_EDGE_DEV_RESEND_BASE_URL=http://127.0.0.1:8899`;
run a tiny local HTTP server on 8899 that answers `POST /emails` with `{"id":"x"}`, `wrangler dev --test-scheduled`, then `curl "http://127.0.0.1:8787/__scheduled?cron=0+*+*+*+*"`.
Unit tests: `node --import tsx --test tests/email-call-alerts.test.mts` (mock transport, in-memory SQLite running the real migration).
