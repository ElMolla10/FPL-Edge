# Personal FPL transfer execution (Mohamed only)

Kill switch: set `FPL_EDGE_PERSONAL_TRANSFER_EXEC` to anything other than `1`, or delete this folder and `app/api/personal/fpl-transfer/**`.

## Why this exists

Edge recommends transfers. The official FPL site is where they are placed. This module is a **personal-only** path so Mohamed can place **any** chosen single transfer (not only the top recommendation) on **his** FPL team from Edge — via Transfers ranked routes, Draft Lab pitch sandbox, or the recommended-move shortcut. It is not marketed. Public copy stays read-only.

## Auth (2025/26)

FPL retired `users.premierleague.com` email/password cookie login.

Current flow (official site + community clients such as mgphp/fpl-mcp):

1. Browser signs in via PingOne at `account.premierleague.com`.
2. Local Storage key `oidc.user:…` holds a rotating `refresh_token`.
3. Exchange: `POST https://account.premierleague.com/as/token` with `grant_type=refresh_token` and public client id `bfcbaf69-aade-4c1b-8f00-c1cb8a193030`.
4. Call FPL with header `X-API-Authorization: Bearer <access_token>`.
5. Transfers: `POST https://fantasy.premierleague.com/api/transfers/` with body `{ chip, entry, event, transfers, confirmed }`. Use `confirmed: false` to validate (preview), `true` to commit.
6. Squad prices: `GET /api/my-team/{entry_id}/` (auth) for selling prices.

## Secrets / env (set by Chief/Mohamed — never paste into chat)

| Name | Purpose |
| --- | --- |
| `FPL_EDGE_PERSONAL_TRANSFER_EXEC` | Must be `1` or the path is dead for everyone |
| `FPL_EDGE_PERSONAL_TRANSFER_ALLOWLIST` | Comma-separated emails; include `imody10@gmail.com` |
| `FPL_EDGE_PERSONAL_FPL_ENTRY_ID` | Mohamed's numeric FPL team id |
| `FPL_EDGE_PERSONAL_FPL_REFRESH_TOKEN` | Seed refresh token (or whole `oidc.user` JSON). Rotations are persisted in D1 `personal_fpl_auth` |


## Gate

`enabled` only when: flag=`1` AND signed-in email on allowlist AND entry id configured AND a refresh token is available (env seed or D1). Everyone else gets the same public read-only behaviour.

## Reconnect FPL

1. In Edge, open the reconnect panel (shown when live bank is unavailable)
2. Prefer **Copy bookmarklet**, then Edit bookmark → paste the full `javascript:…` URL (Chrome Bookmark manager / Safari Edit Bookmarks). Dragging often strips `javascript:`.
3. Sign in at https://fantasy.premierleague.com
4. Click the bookmark — it returns to Edge with `refresh_token` only and auto-saves to D1
5. If the click on FPL does nothing, the bookmark is not a `javascript:` bookmark — copy/paste again. Mobile Safari may block bookmarklets; use advanced paste on desktop.
6. Advanced fallback: paste the bare `refresh_token` field only (never whole `oidc.user` JSON — Worker secrets truncate near 5 KB)

## Live bank / pending squad overlay

`/api/fpl/team` calls `tryFetchLiveTeamFinance` when the requested entry matches
`FPL_EDGE_PERSONAL_FPL_ENTRY_ID` and a refresh token is available (D1 or seed
secret). The transfer **EXEC** kill switch is *not* required for this read-only
overlay — it only gates Place/execute. The overlay prefers `my-team.transfers.bank`
(and live picks / selling prices) over public `entry_history.bank`, which goes
stale after pending next-GW transfers.

Access tokens are cached in D1 (`access_token` / `access_expires_at`) so concurrent
team refreshes do not race-rotate PingOne refresh tokens into `invalid_grant`.
On `invalid_grant` the worker reloads D1 (in case another isolate already rotated)
and, if still dead, adopts a newer `FPL_EDGE_PERSONAL_FPL_REFRESH_TOKEN` seed when
it differs from the failed token.

When overlay fails for the personal entry, the JSON includes a metric-safe
`liveOverlayError` (also mirrored on `manager`), e.g. `token-expired`,
`missing-refresh-token`, `oidc-failed`, `my-team-failed`, `invalid-my-team`.
The UI shows **live bank unavailable** instead of quietly treating £2.1 public
history as live.

### Correctness over availability (personal entry)

For entry `FPL_EDGE_PERSONAL_FPL_ENTRY_ID` (261593):

- Live my-team succeeds → `bankSource: "live-my-team"`, rankings use live bank/picks.
- Live my-team fails (`token-expired`, etc.) → **do not** treat public
  `entry_history` bank as authoritative for Transfers rankings.
  - API sets `liveOverlay: false`, `liveOverlayError`, `rankingFinance: "unavailable"`,
    `manager.bankSource: "unavailable"`, `manager.bank: null`.
  - `publicHistoryBank` may still be present for diagnostics only.
  - Client (`deriveSandboxFinancialContext` / Transfers / Overview) shows a blocking
    empty state: **Live FPL bank unavailable — reconnect FPL** instead of false
    Actionable lists driven by £2.1 history.


Signed-in allowlisted user (no wrangler required):

1. Open Transfers/Overview when the reconnect panel is shown
2. Drag **Send FPL session to Edge** to bookmarks (once)
3. Sign in at https://fantasy.premierleague.com
4. Click the bookmark — Edge captures `refresh_token` via `#fpl_rt=` and
   `POST /api/personal/fpl-auth/reconnect` validates it against PingOne, then writes
   **only** `refresh_token` (+ access cache) to D1 `personal_fpl_auth` (never logged)
5. UI force-refreshes `/api/fpl/team` so `bankSource` flips to `live-my-team`

True OAuth redirect against FPL's public PingOne client
(`bfcbaf69-aade-4c1b-8f00-c1cb8a193030`) is not possible: redirect URIs are locked to

Allowlist + auth required. EXEC kill switch is **not** required for reconnect
(live overlay is read-only). Health check: `GET /api/personal/fpl-auth/health`
(allowlisted) returns metric-safe `{ liveOverlay, liveOverlayError, hasRefreshToken }`.

### Fallback: Worker secret re-seed

If the in-app form is unavailable, update Cloudflare Worker secret
`FPL_EDGE_PERSONAL_FPL_REFRESH_TOKEN`, then optionally
`DELETE FROM personal_fpl_auth WHERE id = 'default';` so the next request adopts
the seed. Confirm `FPL_EDGE_PERSONAL_FPL_ENTRY_ID` is still `261593`.

### Cron keep-alive

Worker cron `0 * * * *` (hourly) runs `keepAlivePersonalFplAuth`:
exchanges/refreshes via the same CAS + access-token D1 cache as live overlay,
persists the new refresh + access tokens, and never invents bank on
`token-expired` (overlay stays unavailable for reconnect).

The CoachApp client must not keep ranking from a stale `fpl-edge-manager` /
`fpl-edge-squad` snapshot. `refreshConnectedTeamFromApi` **always** writes live
overlay bank/picks into localStorage whenever an entry id is present — sign-in
is not required for that local write (account `writeAccountTeam` still runs when
signed in). CoachApp force-refreshes on load, after `/api/squad` hydrate, and on
Transfers mount so Actionable cannot first-paint the stale £2.1 / old XI list.


## Why tokens were dying (and what we changed)

1. **Concurrent PingOne refresh** — access-token cache helped, but when it expired many
   isolates still exchanged the same `refresh_token`. PingOne rotation + reuse detection
   revokes the whole token family → `invalid_grant` / `token-expired`. Fix: D1
   `refresh_lease_until` single-flight before calling `/as/token`.
2. **Whole `oidc.user` JSON in Worker secrets** — env vars cap at **5 KB**. Truncated JSON
   fails parse and was stored as garbage, or `tryAdoptEnvSeed` re-poisoned D1 after a race.
   Fix: extract/store **`refresh_token` only**; reject JSON blobs on adopt/seed.
3. **CAS false-negative after a successful exchange** — in-memory token advanced while D1
   kept the spent refresh → next request killed the family. Fix: force-persist when CAS
   fails but D1 still holds the spent token.
4. **PingOne absolute session (~30 days since last interactive sign-on)** — refresh does
   **not** extend the session. Keep-alive preserves rotation inside that window; after
