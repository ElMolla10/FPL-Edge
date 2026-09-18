# Personal FPL transfer execution (Mohamed only)

Kill switch: set `FPL_EDGE_PERSONAL_TRANSFER_EXEC` to anything other than `1`, or delete this folder and `app/api/personal/fpl-transfer/**`.

## Why this exists

Edge recommends transfers. The official FPL site is where they are placed. This module is a **personal-only** path so Mohamed can place a recommended transfer on **his** FPL team from Edge. It is not marketed. Public copy stays read-only.

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
