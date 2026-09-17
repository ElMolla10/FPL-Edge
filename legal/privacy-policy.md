<!--
DRAFT — NOT REVIEWED, NOT PUBLISHED.
Every data category listed below was verified directly against db/schema.ts and the actual code
paths that read/write it (app/lib/auth.ts, app/api/squad/route.ts, app/lib/billing/*) as of this
commit -- not written from a generic privacy-policy template. [BRACKETED] items are facts only
Mohamed can supply. See the "Open items" section at the end for the real GDPR gaps found during
this investigation.
-->

# Privacy Policy — FPL Edge (DRAFT)

**Last updated:** [DATE]

## 1. Who controls your data

[LEGAL ENTITY NAME OR INDIVIDUAL NAME] ("we," "us") is the data controller for the personal data described below, collected through the FPL Edge web application at [DOMAIN]. Contact for any privacy request: [PRIVACY CONTACT EMAIL].

## 2. What we actually collect and store

This list reflects the real columns in the application's database (`db/schema.ts`), not a generic description:

| Data | Why we have it | Where |
|---|---|---|
| Email address | Account identity — the single identifier linking your password and/or ChatGPT sign-in to one account | `users` table |
| Password (as a salted PBKDF2 hash — we never store your actual password) | To authenticate you if you use email/password sign-in | `users` table |
| Display name (optional) | Shown back to you in the app | `users` table |
| ChatGPT-linked timestamp | Records that your account was verified via ChatGPT sign-in | `users` table |
| Account creation/update timestamps | Standard record-keeping | `users` table |
| Pro entitlement status, expiry date, and Stripe customer ID | To know whether you have Pro access and to reconcile Stripe payment/refund events with your account | `users` table |
| Session tokens | To keep you signed in; a session is a random token, not derived from your password, and expires automatically (30 days) or immediately on sign-out | `sessions` table |
| Your official FPL Team ID and derived squad, watchlist, locks, captain/vice picks, saved plans, and planned chips | To power the app's actual function: reading your public FPL team and generating recommendations for it | `squad_data` table |

**What we do *not* collect:** we never ask for or store your official Fantasy Premier League account password. We don't collect payment card details ourselves — Stripe's hosted checkout collects those directly (see §4).

**Locally stored, not sent to us:** some preferences (e.g. light/dark theme, a locally-built draft squad before you connect a real team) are stored only in your browser's local storage, never transmitted to our servers.

## 3. Why we process this data (lawful basis)

Processing your account and squad data is necessary to perform the contract between you and us — i.e., to provide the FPL Edge service you sign up for. Processing payment data with Stripe is necessary to fulfil a purchase you initiate. *[If operating in the EU/UK: this section should confirm the correct lawful basis under GDPR Art. 6 with a lawyer — "contract" is very likely correct here but this is a legal confirmation, not something to assume from this description alone.]*

## 4. Who we share data with

- **Stripe** (payment processor) — if you purchase Pro access, Stripe receives your email and payment details directly (we never see or store your card number). Stripe's own privacy policy governs its handling of that data.
- **Cloudflare** (hosting infrastructure) — the application and its database run on Cloudflare Workers and Cloudflare D1. Cloudflare processes data on our behalf as our hosting provider.
- **The official Fantasy Premier League API** — we read public data from it (fixtures, prices, and, for your connected Team ID, your public squad/history). We do not send your FPL Edge account data to it; the only thing "sent" is the public Team ID you already control and could look up yourself.

We do not sell your data, and we do not share it with advertisers — FPL Edge has no advertising or tracking infrastructure.

## 5. Cookies and local storage

FPL Edge sets one cookie (`fpl_edge_session`) to keep you signed in. It's strictly necessary for the service to function (there is no tracking or advertising cookie), is `HttpOnly` and `Secure`, and expires automatically. We also use your browser's local storage for app preferences and cached data as described in §2. *[Whether this exempts the cookie from an EU/UK cookie-consent banner should be confirmed with a lawyer, though "strictly necessary" cookies are the standard exemption category.]*

## 6. Data retention

[RETENTION PERIOD — not specified anywhere in the current codebase; this is a policy decision Mohamed needs to make, e.g. "for as long as your account is active, plus N days/months after deletion for backups."] There is currently no automatic deletion job in the codebase — retention today is, in practice, indefinite until a manual deletion request is processed (see §7 and the Open Items below).

## 7. Your rights

Depending on where you live, you may have rights to access, correct, export, or delete your personal data, and to object to or restrict certain processing. To exercise any of these rights, contact [PRIVACY CONTACT EMAIL].

**Current process (real, not aspirational):** FPL Edge does not yet have a self-service data export or account deletion feature. Requests are handled manually by [Mohamed / support contact] until that's built. See the Open Items section — this is flagged as a real gap, not glossed over.

## 8. Where your data is stored

Your data is stored in Cloudflare D1, part of Cloudflare's global infrastructure. [SPECIFIC DATA REGION — not something this investigation could confirm; Cloudflare D1's exact storage location depends on the Cloudflare account's configuration, which wasn't accessible during this draft. Check the Cloudflare dashboard's D1 database settings before stating a specific region/country here.]

## 9. Children

FPL Edge is not directed at children under [13 / 16 — pick per jurisdiction] and we do not knowingly collect data from them.

## 10. Changes to this policy

We may update this policy; material changes will be reflected by a new "Last updated" date.

---

**Open items for Mohamed (real gaps found during this investigation, not invented):**
- **No self-service account deletion or data export exists in the app today.** This is a real GDPR Article 17 (erasure) / Article 20 (portability) gap if any EU/UK users sign up. Options: (a) build a self-service "delete my account" + "export my data" flow before/shortly after launch, or (b) launch with a documented manual-request process (as drafted above) and build self-service later. This is exactly the kind of decision the goal's Rule #4 (design checkpoint before implementing) and Rule #7 (stop and ask when ambiguous) apply to — it's a real feature-scope decision, not something to build silently.
- **No defined data-retention period or deletion job exists.** §6 above is a placeholder pending a real policy decision.
- **Cloudflare D1's actual storage region wasn't determined** — needs checking against the live Cloudflare account, not guessed here.
- Legal entity name, contact email, and jurisdiction are placeholders throughout, same as the Terms of Service draft.
- This document, like the ToS, should go through actual legal review (especially §3's lawful-basis claim and §9's age threshold, both jurisdiction-dependent) before publishing.
