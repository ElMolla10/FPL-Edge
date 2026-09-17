<!--
DRAFT — NOT REVIEWED, NOT PUBLISHED.
Generated from the actual app behavior in this repository as of this commit (Phase 4 of the
launch-readiness goal). This is a starting point for Mohamed and, ideally, a lawyer to review --
not a document to wire into any live route or link from the app. Every [BRACKETED] placeholder is
a fact only Mohamed can supply; nothing has been invented to fill them in. Everything outside the
brackets is a description of what the app actually does, verified against the codebase, not
assumed from what a typical SaaS ToS says.
-->

# Terms of Service — FPL Edge (DRAFT)

**Last updated:** [DATE]

## 1. Who this agreement is with

FPL Edge is operated by [LEGAL ENTITY NAME OR INDIVIDUAL NAME], [BUSINESS ADDRESS OR "an individual based in [COUNTRY]"] ("we," "us," "FPL Edge"). These Terms govern your use of the FPL Edge web application at [DOMAIN].

**Not affiliated with the Premier League.** FPL Edge is an independent Fantasy Premier League decision-assistant tool. It is not affiliated with, endorsed by, or connected to the Premier League, the Fantasy Premier League game, or any of their operators.

## 2. What the service is

FPL Edge reads publicly available official Fantasy Premier League data (player prices, fixtures, official status flags, and — if you connect your Team ID — your own public squad and history) and generates projections, lineup and transfer recommendations, and planning tools based on that data.

**Read-only.** FPL Edge never asks for your official FPL account password and never makes changes to your official FPL team. Connecting a Team ID only lets FPL Edge read the public data associated with that ID.

**Estimates, not guarantees.** Projections, recommendations, and rank estimates produced by FPL Edge are statistical estimates with disclosed uncertainty. They are not guarantees of any outcome, and FPL Edge is not responsible for the results of any Fantasy Premier League decision you make using it.

## 3. Accounts

You can create an account with an email and password, or by signing in with ChatGPT (which verifies your email through OpenAI). You're responsible for keeping your login credentials secure and for all activity under your account.

**Account deletion.** As of this draft, FPL Edge does not have a self-service "delete my account" feature. To request deletion of your account and associated data, contact [SUPPORT/PRIVACY CONTACT EMAIL]; see the Privacy Policy for how this is handled. *(Flagged for Mohamed: this is a real, current gap — see the Phase 4 note below on whether to build self-service deletion before or shortly after launch.)*

## 4. Free and Pro access

FPL Edge offers a Free tier and a Pro tier, as described on the pricing section of the site. Pro access is sold as a single payment covering one Premier League season (not a recurring subscription) and is processed by Stripe. See the Refund Policy for how refunds and the resulting loss of Pro access are handled.

We may change what's included in Free or Pro from time to time; if we do, the site's pricing section reflects the current, real feature split — this document doesn't duplicate that list so the two can't drift out of sync.

## 5. Acceptable use

You agree not to: use the service to violate any law; attempt to interfere with, disrupt, or gain unauthorized access to the service or other users' accounts; scrape or bulk-extract data from the service beyond your own account's normal use; or resell or redistribute the service without our written permission.

We may suspend or terminate access for violation of these terms.

## 6. Disclaimers and limitation of liability

The service is provided "as is." To the maximum extent permitted by [GOVERNING LAW], we disclaim all warranties, express or implied, and are not liable for indirect, incidental, or consequential damages arising from your use of the service, including any Fantasy Premier League result or financial decision made based on it.

*[Flagged for legal review: liability limitations are jurisdiction-dependent and some cannot be disclaimed by contract in certain jurisdictions (e.g., consumer-protection law in the EU/UK). This section needs a lawyer, not just Mohamed's sign-off, before publishing.]*

## 7. Changes to these terms

We may update these Terms. Material changes will be reflected by an updated "Last updated" date; continued use of the service after a change means you accept the updated terms.

## 8. Governing law

These Terms are governed by the laws of [JURISDICTION — not assumed or inferred; this is a business decision, not a fact derivable from the app].

## 9. Contact

Questions about these Terms: [CONTACT EMAIL].

---

**Open items for Mohamed before this can be published (from the Phase 4 investigation, not invented):**
- Legal entity/individual name, business address, contact email, governing law/jurisdiction — none of these exist anywhere in the current codebase or marketing copy; all are placeholders above.
- Whether to build self-service account deletion before launch, or accept a manual request-based process at launch (real GDPR "right to erasure" implications — see the Privacy Policy draft's own note).
- This entire document, and especially §6 (liability) and §8 (governing law), should go through actual legal review before publishing — this draft is a structured starting point reflecting real app behavior, not a substitute for that review.
