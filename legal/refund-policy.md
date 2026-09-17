<!--
DRAFT — NOT REVIEWED BY A LAWYER, NOT PUBLISHED.
Grounded in the actual billing implementation (app/lib/billing/webhook-handler.ts,
app/api/billing/checkout/route.ts): FPL Edge Pro is a single one-time payment per season,
processed by Stripe, with a webhook that revokes Pro access the moment Stripe reports a refund.
Refund window is now a real, decided policy (14 days, full refund) rather than a placeholder.
[DOMAIN] is the one remaining fact-placeholder.
-->

# Refund Policy — FPL Edge (DRAFT)

**Last updated:** [DATE]

## How Pro access is sold

FPL Edge Pro is a single payment covering one Premier League season — not a recurring subscription. There is nothing to "cancel," because nothing renews automatically; next season's access is a separate, new purchase.

## Refund window

Full refund, no questions asked, if requested within **14 days of purchase**. No partial-season proration, and no refunds — for any reason tied to how much of the season has passed — after that 14-day window closes.

This 14-day window is a deliberate choice, not an accident: it matches the EU/UK statutory minimum cooling-off period for digital content, so the policy simply *meets* that right rather than trying to work around it — there's no separate consent/waiver checkbox needed at checkout, because nothing here tries to take the right away or narrow it. If a future jurisdiction's rules ever require something stricter than 14 days, that's a real question to revisit then, not something resolved by this document alone.

## How a refund actually works today

There is no self-service "request a refund" button in the app. To request one, contact support@[DOMAIN] (a dedicated support address, not a personal inbox) within the 14-day window above. If a refund is approved and processed through Stripe, FPL Edge's webhook handling automatically revokes Pro access as soon as Stripe confirms the refund — this isn't a manual follow-up step, it's an automated part of the billing system (`charge.refunded` → access reverts to Free immediately).

## Payment processing errors

If you were charged in error (e.g., a duplicate charge from a technical issue), contact support@[DOMAIN] and we'll investigate and refund genuine errors regardless of the 14-day window above.

---

**Open items for Mohamed:**
- **[DOMAIN]** — confirm the production domain for the support@ contact address.
- Once real Stripe test credentials exist, the `charge.refunded` → access-revoked path described above should be exercised against Stripe's test-mode event simulator (not just the mocked unit tests already passing) before this policy goes live, so the policy's claim about automatic revocation is verified against the real integration, not just the code that's supposed to implement it.
