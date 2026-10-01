# Security notes

Scope: how FPL Edge protects accounts and requests, and the decisions behind it. Code pointers are
authoritative; this file explains the why. (Audit "PR A", items 1-8.)

## Auth model (unchanged, do not weaken)

* Identity = the `fpl_edge_session` cookie only (`HttpOnly; Secure; SameSite=Lax`), backed by the D1 `sessions` table.
* `oai-*` request headers are stripped in `worker/index.ts` and never read anywhere. There is no header-based auth.
* Passwords: PBKDF2-HMAC-SHA256, 100k iterations (the Workers Web Crypto maximum), per-user random salt.

## Signup / login (items 1, 2, 3)

| Behaviour | Where |
| --- | --- |
| `POST /api/auth/signup` answers **200 `{"ok":true,"status":"check-your-email"}` and sets no cookie** for a new *and* an already-registered email. No 409, no account-existence oracle. | `app/api/auth/signup/route.ts`, `registerAccountWith` in `app/lib/auth-core.ts` |
| Duplicate path still runs one PBKDF2 hash so timing stays roughly equal. Login does the same for unknown emails. | `auth-core.ts` |
| A duplicate signup **never modifies** the existing account (no password overwrite). A unique-index race on insert is swallowed into the same response. | `auth-core.ts` |
| Signup is rate limited **per client IP**: 10 attempts / 1 h fixed window, then `429` + `Retry-After` (same body shape as login's 429). Checked *before* any hashing. | `consumeSignupAttempt` in `app/lib/login-rate-limit-store.ts` |
| The limiter reuses the `login_rate_limits` table with key namespace `signup:ip:<ip>` and one atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` statement, so parallel requests cannot slip under the limit. It cannot lock anyone out of sign-in (different keys). Fails open if the table is missing (migration lag). | same |
| Password length: signup requires **8-128** characters. Login accepts up to **1024** so accounts that pre-date the cap can still sign in; longer is rejected as a bad request. | `validateNewPassword`, `MAX_LOGIN_PASSWORD_LENGTH` |

**UX trade-off (needs a product decision).** The site has no email-sending infrastructure, so it cannot tell the
*real* owner of an address "someone tried to register with your email". The generic response is therefore the same
for everyone, and the UI (`AuthForm`, `CoachApp` account bar) follows a successful signup with an automatic login using
the same credentials. Consequences:

* New user: signs up, is signed in immediately. Same experience as before.
* Someone re-registering an existing email with the *right* password: is signed in (it is a login). With a *wrong*
  password: sees "We could not finish setting up this account. If you already have an account with this email, sign in
  with your existing password." and counts one failed login against the normal login limiter. This message is the one
  remaining, deliberately vague, hint that the address may be taken; it is only reachable after passing the signup IP
  limit and is bounded by the login per-email/per-IP limits.
* There is no email verification, so anyone can register an address they do not own. The generic response removes the
  *oracle*, not the *squatting*.

The full fix is email verification + a "you already have an account" email to the owner. That needs a provider and sender
domain decision: see `docs/PROPOSAL-password-reset-email-verification.md` (item 8).

## Security headers (item 4)

**next.config.ts `headers()` is not used**: under vinext on Workers it is only applied to some responses. Verified on the
production build: with a probe header in `headers()`, `/api/auth/me` and `/signin` carried it but `/` did not. So headers
are applied in the Worker wrapper instead: `worker/index.ts` -> `prepareSecurity()` / `finalize()` in
`app/lib/security-headers.ts`, on every response including the image endpoint.

| Header | Value | Notes |
| --- | --- | --- |
| `Content-Security-Policy` (HTML only) | `default-src 'self'; script-src 'self' 'nonce-<per-request>'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; frame-src 'none'; upgrade-insecure-requests` | Enforcing. Scripts are strict (no `unsafe-inline`, no `unsafe-eval`, no remote origins). `style-src` keeps `'unsafe-inline'` because React emits `style=""` attributes that nonces cannot cover. |
| `Strict-Transport-Security` | `max-age=31536000` | https only. No `includeSubDomains`/`preload` (deliberately reversible). |
| `X-Frame-Options` | `DENY` | Same intent as `frame-ancestors 'none'` for old browsers. |
| `X-Content-Type-Options` | `nosniff` | |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | |
| `Permissions-Policy` | camera, microphone, geolocation, payment, usb, interest-cohort all denied | |

Nonce, not hashes: vinext emits several inline scripts per page whose content changes per request (RSC flight chunks,
`__VINEXT_RSC_NAV__` pathname). The Worker mints a 128-bit nonce per request, sets it on the *request*
`content-security-policy` header (always overwriting anything the client sent), vinext stamps it on its own inline
scripts/styles, and `app/layout.tsx` stamps it on the theme-init script (the only app-authored inline script; a test
fails if another appears).

Origins: the browser only talks to the site itself. FPL API, PingOne and Paymob's intention API are called server-side.
Fonts are served from the site (`/assets/_vinext_fonts/...`). Paymob checkout is a top-level navigation
(`window.location.assign(checkoutUrl)`), which CSP does not govern, and the return URL is same-origin `/pay?checkout=return`.
If a future feature embeds Paymob in an iframe or loads analytics, extend `buildCsp()` (`frame-src` / `script-src` / `connect-src`).

Rollback / debug: set the Worker var `FPL_EDGE_CSP_MODE=report-only` to downgrade only the CSP to
`Content-Security-Policy-Report-Only` without a redeploy of code (all other headers stay enforcing). Not set by default.

## CSRF (item 6)

Defence in depth on top of `SameSite=Lax`: every browser-facing state-changing handler calls
`rejectCrossSite(request)` (`app/lib/request-guards.ts`) as its first statement. It rejects with `403` when
`Sec-Fetch-Site` is `cross-site`/`same-site`, or, if that header is absent, when `Origin` differs from the request origin.
Requests with neither header (curl, server clients) pass: they cannot ride a victim's cookies.

Covered: `auth/login`, `auth/signup`, `auth/logout`, `PUT squad`, `personal/fpl-transfer/execute` (checked before
auth/env/FPL work), `personal/fpl-auth/reconnect`, `season-pass/checkout`, `season-pass/dev-grant`.
Exempt by design: `season-pass/callback` (Paymob server-to-server webhook, authenticated by HMAC, no browser, no cookies).

**No state-changing GET handlers exist.** Audited every `app/api/**/route.ts`: the GET handlers (`fpl*`, `auth/me`,
`squad`, `personal/*/status|health`) only read. (`fpl/team` and `personal/fpl-auth/health` go through the live-overlay helper, which may refresh the
cached FPL access token as a side-effect of a read: idempotent cache maintenance, not a user-visible state change, and not
reachable to change anything the requester controls.) `tests/audit-a-request-guards.test.mts` enforces both facts: every mutating method must call
`rejectCrossSite`, and no GET handler may contain write calls.

## Request bodies (item 7)

Bodies go through `readJsonBody` (size cap, 413) and small hand-rolled validators (no zod dependency in the repo):
`parseStringFields` (auth), `parseSquadBody`, `parseTransferExecuteBody`, all in `app/lib/request-guards.ts`. Wrong
types, non-objects, oversized arrays and junk ids return `400`. Valid requests from the shipped client are unchanged;
plans/locks/manager remain opaque client-owned JSON (type + size checked, inner schema not).

## Expired-data pruning (item 5)

The hourly cron (`wrangler.jsonc` `triggers.crons`) now also runs `pruneExpiredData` (`app/lib/maintenance.ts`):
`DELETE FROM sessions WHERE expires_at < now` and deletion of `login_rate_limits` rows whose window has elapsed and are
not blocked (window = the longest namespace window, 1 h). Pruning a stale row is behaviourally identical to no row.
Migration `0010_prune_indexes.sql` adds idempotent indexes on both filter columns. It runs in its own `waitUntil` next to
the FPL token keep-alive; neither can block the other.

## Not done

Password reset and email verification: see `docs/PROPOSAL-password-reset-email-verification.md`.

## Email call alerts (opt-in)

See `docs/EMAIL_ALERTS.md`. `PUT /api/account/notifications` follows the same pattern as the other mutations: `rejectCrossSite` → session cookie
(`getCurrentUser`, no header auth) → hand-rolled body validator → per-user rate limit → write. The hourly cron's third `waitUntil` job reads D1 directly and is inert without the
`RESEND_API_KEY` / `RESEND_FROM` Worker secrets. The dev-only Resend base-URL override is honoured only with `FPL_EDGE_DEV_MODE=1` and a loopback `http` URL, and is absent from `wrangler.jsonc`.
