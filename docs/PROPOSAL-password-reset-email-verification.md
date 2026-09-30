# Proposal: password reset + email verification

Status: **proposal only, not implemented** (audit item 8). Needs decisions from the owner (see the end).

## Findings

There is **no email-sending infrastructure** in the repo: no provider SDK, no `send_email` binding in `wrangler.jsonc`,
no `RESEND_*`/`MAILCHANNELS_*`/SMTP variables, no sender domain configured. The only account recovery today is none:
a forgotten password means a lost account. Because provider and sender domain are external decisions, nothing was built.

## Provider options

| Option | Fit | Notes |
| --- | --- | --- |
| **Cloudflare Email Service** (`send_email` Workers binding, `env.EMAIL.send({...})`) | Best fit: same platform, no API key secret, one binding line in `wrangler.jsonc`. | Public beta since April 2026, needs the Workers Paid plan to send to arbitrary recipients (3,000/month included, then about $0.35 per 1,000), and the sender domain must be onboarded (DNS records) in the Cloudflare account. Beta risk. Confirm current terms at implementation time. |
| **Resend** (REST API via `fetch`) | Mature deliverability, generous free tier, simple API. | One secret (`RESEND_API_KEY`), a verified sender domain (SPF/DKIM DNS), an outbound `fetch` from the Worker (add nothing to CSP: server-side). |
| MailChannels (Workers integration) | Historically free for Workers; the free Workers offering was discontinued, so it is now a paid API with an API key. | Not recommended as a new dependency. |

Recommendation: Resend if the owner wants it live soon and has (or will buy) a domain; Cloudflare Email Service if staying
all-in on Cloudflare is preferred and the beta status is acceptable. Either way the code sits behind a tiny
`sendEmail({to, subject, text})` interface, so the choice is a one-file swap.

## Data model (new migration `0011_email_tokens.sql`, idempotent)

```sql
CREATE TABLE IF NOT EXISTS email_tokens (
  id            TEXT PRIMARY KEY,          -- random UUID, public handle, not secret
  user_id       TEXT NOT NULL REFERENCES users(id),
  purpose       TEXT NOT NULL,             -- 'verify_email' | 'reset_password'
  token_hash    TEXT NOT NULL UNIQUE,      -- SHA-256 of the 32-byte random token; the raw token is only in the email
  email         TEXT NOT NULL,             -- address the token was issued to (guards against email change)
  expires_at    TEXT NOT NULL,             -- ISO; verify: 24 h, reset: 30 min
  used_at       TEXT,                      -- set atomically on consumption -> single use
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS email_tokens_user_purpose_idx ON email_tokens(user_id, purpose);
CREATE INDEX IF NOT EXISTS email_tokens_expires_idx ON email_tokens(expires_at);
ALTER TABLE users ADD COLUMN email_verified_at TEXT;   -- guarded so a re-run is a no-op
```

Tokens: 32 random bytes, base64url, stored **only as SHA-256 hashes** (a DB read must not yield usable links).
Consumption is one statement: `UPDATE email_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>? RETURNING user_id`
so a token is single use even under races. Issuing a new token of the same purpose invalidates older ones.
The existing hourly cron gets one more `DELETE FROM email_tokens WHERE expires_at < now - 7 days`.

## Flows

**Signup + verification**
1. `POST /api/auth/signup` (already non-oracle). New email: create user (unverified), send verify link; existing email:
   send the owner a "you already have an account, sign in or reset your password" mail. Response is the same generic
   `check-your-email` either way. This finally makes the generic response true and removes the UX gap documented in `docs/SECURITY.md`.
2. `GET /verify-email?token=...` renders a page that `POST`s the token (a GET must not mutate; link scanners prefetch links).
   On success set `email_verified_at`, create the session.
3. Decision: do unverified accounts get a session immediately (soft launch) or only after verification (strict)?
   Paid features (season pass) should require a verified email.

**Password reset**
1. `POST /api/auth/forgot` `{email}` -> always `200 generic`. If the account exists, send a reset link (30 min, single use).
2. `POST /api/auth/reset` `{token, newPassword}` -> validate with `validateNewPassword`, consume the token atomically,
   update `password_hash`, **delete all of that user's sessions** (kicks out an attacker), clear login rate-limit buckets,
   send a "your password was changed" notice.

**Rate limiting** (reusing `login_rate_limits`, new namespaces): `forgot:ip:<ip>` 5/h, `forgot:email:<email>` 3/h
(so nobody can mail-bomb an address), `verify-resend:email:<email>` 3/h, `reset:ip:<ip>` 10/h. Same atomic upsert as signup.
All new routes get `rejectCrossSite` and body validation.

**Hardening notes**: constant-shape responses and a dummy hash/send delay so timing does not leak existence; build the
link from a configured `APP_ORIGIN`, never from the `Host` header (host-header poisoning); `Referrer-Policy` is already
`strict-origin-when-cross-origin` and reset pages should add `no-referrer`; email content is plain text first.

## Effort

* Provider adapter + config + local dev stub (logs the link): 0.5 day
* Migration, token store, atomic consume, cron cleanup + tests: 1 day
* Routes (`forgot`, `reset`, `verify`, resend), rate limits, pages/UI (`/forgot`, `/reset`, `/verify-email`, banners): 1.5 days
* Deliverability setup (DNS: SPF, DKIM, DMARC), staging test, docs: 0.5 day, mostly waiting on DNS

About 3.5 developer days plus DNS propagation.

## Decisions needed from Mohamed

1. **Provider**: Resend vs Cloudflare Email Service (beta, Workers Paid).
2. **Sender domain and address** (for example `no-reply@<your-domain>`); do you own a domain to put SPF/DKIM on? `workers.dev` cannot send mail.
3. **Verification strictness**: immediate session for unverified accounts, or block until verified? Require verified email before purchase?
4. **Existing users**: they have no `email_verified_at`; grandfather them as verified, or ask them to verify at next login?
5. **Cost ceiling / abuse budget**: per-address and per-IP send limits above are proposals.
6. Whether to make the generic "check your email" signup copy honest right away (i.e. ship this proposal) or accept the
   interim behaviour described in `docs/SECURITY.md`.
