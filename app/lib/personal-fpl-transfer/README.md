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

How Mohamed grabs a refresh token in the browser (he does this himself):

1. Sign in at https://fantasy.premierleague.com
2. DevTools → Application → Local Storage → `https://fantasy.premierleague.com`
3. Copy the value of the key starting `oidc.user:` (whole JSON is fine)
4. Put it in the Cloudflare secret / env — do not paste it into chat

## Gate

`enabled` only when: flag=`1` AND signed-in email on allowlist AND entry id configured AND a refresh token is available (env seed or D1). Everyone else gets the same public read-only behaviour.

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

### If live overlay stays on `token-expired`

Mohamed must re-seed the Worker secret (do not paste the token into chat):

1. Sign in at https://fantasy.premierleague.com
2. DevTools → Application → Local Storage → `https://fantasy.premierleague.com`
3. Copy the `oidc.user:…` JSON (or its `refresh_token`)
4. Update Cloudflare Worker secret `FPL_EDGE_PERSONAL_FPL_REFRESH_TOKEN`
5. Optionally clear the D1 row so the seed is adopted immediately:
   `DELETE FROM personal_fpl_auth WHERE id = 'default';`
   (next request re-seeds from the secret)

Confirm `FPL_EDGE_PERSONAL_FPL_ENTRY_ID` is still `261593`.

The CoachApp client must not keep ranking from a stale `fpl-edge-manager` /
`fpl-edge-squad` snapshot. `refreshConnectedTeamFromApi` **always** writes live
overlay bank/picks into localStorage whenever an entry id is present — sign-in
is not required for that local write (account `writeAccountTeam` still runs when
signed in). CoachApp force-refreshes on load, after `/api/squad` hydrate, and on
Transfers mount so Actionable cannot first-paint the stale £2.1 / old XI list.
