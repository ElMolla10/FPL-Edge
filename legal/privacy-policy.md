<!--
DRAFT — NOT REVIEWED BY A LAWYER, NOT PUBLISHED.
Every data category listed below was verified directly against db/schema.ts and the actual code
paths that read/write it (app/lib/auth.ts, app/api/squad/route.ts, app/lib/billing/*). Updated with
Mohamed's real decisions on entity, retention, contact, and the children's age threshold. [DOMAIN]
and the Cloudflare D1 region (§8) are the two remaining fact-placeholders; the GDPR lawful-basis
question (§3) is a standing legal-review flag, not a placeholder waiting on Mohamed.
-->

# Privacy Policy — FPL Edge (DRAFT)

**Last updated:** [DATE]

## 1. Who controls your data

Mohamed Ehab, an individual based in Cairo, Egypt (no separate registered business entity) ("we," "us") is the data controller for the personal data described below, collected through the FPL Edge web application at [DOMAIN]. Contact for any privacy request: support@[DOMAIN] (a dedicated support address, not a personal inbox).

## 2. What we actually collect and store

This list reflects the real columns in the application's database (`db/schema.ts`), not a generic description:

| Data | Why we have it | Where |
|---|---|---|
| Email address | Account identity — the single identifier linking your password and/or ChatGPT sign-in to one account | `users` table |
| Password (as a salted PBKDF2 hash — we never store your actual password) | To authenticate you if you use email/password sign-in | `users` table |
| Display name (optional) | Shown back to you in the app | `users` table |
| ChatGPT-linked timestamp | Records that your account was verified via ChatGPT sign-in | `users` table |
| Account creation/update timestamps | Standard record-keeping | `users` table |
| Pro entitlement status and expiry date | To know whether you have Pro access | `users` table |
| A mapping from a payment order id to your account | To resolve a payment provider's confirmation (or refund) back to your account | `pending_payments` table |
| Session tokens | To keep you signed in; a session is a random token, not derived from your password, and expires automatically (30 days) or immediately on sign-out | `sessions` table |
| Your official FPL Team ID and derived squad, watchlist, locks, captain/vice picks, saved plans, and planned chips | To power the app's actual function: reading your public FPL team and generating recommendations for it | `squad_data` table |

**What we do *not* collect:** we never ask for or store your official Fantasy Premier League account password. We don't collect payment card details ourselves — our payment processor's hosted checkout page collects those directly (see §4).

**Locally stored, not sent to us:** some preferences (e.g. light/dark theme, a locally-built draft squad before you connect a real team) are stored only in your browser's local storage, never transmitted to our servers.

## 3. Why we process this data (lawful basis)

Processing your account and squad data is necessary to perform the contract between you and us — i.e., to provide the FPL Edge service you sign up for. Processing payment data with our payment processor is necessary to fulfil a purchase you initiate.

*[Standing legal-review flag, not resolved by choosing Egypt as the primary governing jurisdiction elsewhere in these documents: if any user is in the EU/UK, GDPR may still apply to processing their data regardless of where FPL Edge itself is based. "Contract" is very likely the correct lawful basis under GDPR Art. 6 here, but this needs an actual lawyer's confirmation, not just this description, for as long as EU/UK users are a realistic possibility.]*

## 4. Who we share data with

- **Paymob** (payment processor) — if you purchase Pro access, Paymob receives your email and payment details directly (we never see or store your card number). Paymob's own privacy policy governs its handling of that data.
- **Cloudflare** (hosting infrastructure) — the application and its database run on Cloudflare Workers and Cloudflare D1. Cloudflare processes data on our behalf as our hosting provider.
- **The official Fantasy Premier League API** — we read public data from it (fixtures, prices, and, for your connected Team ID, your public squad/history). We do not send your FPL Edge account data to it; the only thing "sent" is the public Team ID you already control and could look up yourself.

We do not sell your data, and we do not share it with advertisers — FPL Edge has no advertising or tracking infrastructure.

## 5. Cookies and local storage

FPL Edge sets one cookie (`fpl_edge_session`) to keep you signed in. It's strictly necessary for the service to function (there is no tracking or advertising cookie), is `HttpOnly` and `Secure`, and expires automatically. We also use your browser's local storage for app preferences and cached data as described in §2. *[Whether this exempts the cookie from an EU/UK cookie-consent banner should be confirmed with a lawyer, though "strictly necessary" cookies are the standard exemption category.]*

## 6. Data retention

We keep your data for as long as your account is active, plus 30 days after a deletion request, before it's removed — the same 30-day window the app already uses for session-token expiry, not a separate arbitrary number. There is currently no automatic deletion job in the codebase; today, a deletion request is processed manually within that 30-day window rather than by an automated system (see §7).

## 7. Your rights

Depending on where you live, you may have rights to access, correct, export, or delete your personal data, and to object to or restrict certain processing. To exercise any of these rights, contact support@[DOMAIN].

**Current process (real, not aspirational):** FPL Edge does not yet have a self-service data export or account deletion feature. Requests are handled manually until that's built. This is the deliberate launch-time choice given zero real users today, not an oversight — but it belongs on the near-term backlog, not permanent deferral: it gets materially more expensive to retrofit self-service export/deletion once real EU/UK users (with GDPR Art. 17/20 rights) actually exist, so this should be revisited as soon as the user base is no longer zero.

## 8. Where your data is stored

Your data is stored in Cloudflare D1, part of Cloudflare's global infrastructure. [SPECIFIC DATA REGION — not something this investigation could confirm; Cloudflare D1's exact storage location depends on the Cloudflare account's own configuration. Mohamed needs to check the actual Cloudflare dashboard's D1 database settings directly — this isn't something resolvable from the codebase.]

## 9. Children

FPL Edge is not directed at children under 16 and we do not knowingly collect data from them.

## 10. Changes to this policy

We may update this policy; material changes will be reflected by a new "Last updated" date.

---

**Open items for Mohamed:**
- **[DOMAIN]** — confirm the production domain; used throughout for the site URL and the support@ contact address.
- **§8's Cloudflare D1 data region** — check the live Cloudflare dashboard directly; not something derivable from this codebase.
- **§3's GDPR lawful-basis question is a standing legal-review flag**, independent of the Egypt-jurisdiction decision elsewhere — keep this open for an actual lawyer, not just a sign-off, for as long as EU/UK users are possible.
- **Self-service deletion/export is on the near-term backlog**, not permanently deferred — revisit once real users (especially EU/UK ones) exist, per §7's own note.
- This document should go through actual legal review (§3 and §5's cookie-exemption claim in particular) before publishing.
