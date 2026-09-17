<!--
DRAFT — NOT REVIEWED, NOT PUBLISHED.
Grounded in the actual billing implementation (app/lib/billing/webhook-handler.ts,
app/api/billing/checkout/route.ts) as of this commit: FPL Edge Pro is a single one-time payment
per season, processed by Stripe, with a webhook that revokes Pro access the moment Stripe reports
a refund. There is currently no self-service "request a refund" button in the app -- refunds are
issued by whoever operates Stripe (today, that's a manual action in the Stripe dashboard, not an
in-app flow). [BRACKETED] items are business-policy decisions only Mohamed can make.
-->

# Refund Policy — FPL Edge (DRAFT)

**Last updated:** [DATE]

## How Pro access is sold

FPL Edge Pro is a single payment covering one Premier League season — not a recurring subscription. There is nothing to "cancel," because nothing renews automatically; next season's access is a separate, new purchase.

## Refund window

[REFUND WINDOW — a real business-policy decision, not invented here. Common approaches for this kind of product: (a) a fixed cooling-off period, e.g. "refundable within 14 days of purchase," (b) refundable only before a defined usage/season milestone (e.g. "before Gameweek 1 deadline"), or (c) no refunds once purchased, stated plainly. Pick one and state it here — don't leave it undecided once this goes live, since the webhook below will honor whatever refund Stripe actually processes regardless of what this policy says, so the policy and the actual practice need to agree.]

*[Legal note, not invented as fact: in the UK/EU, consumers generally have a 14-day statutory right to cancel a distance contract for digital content, which can be waived only if the consumer is clearly informed and explicitly consents to immediate access and to losing that right. If Pro access is granted immediately on payment (which is how the current checkout flow works), this needs a lawyer's confirmation on whether/how that waiver needs to be presented at checkout — this is not something to guess at.]*

## How a refund actually works today

There is no self-service "request a refund" button in the app. To request one, contact [SUPPORT/REFUND CONTACT EMAIL]. If a refund is approved and processed through Stripe, FPL Edge's webhook handling automatically revokes Pro access as soon as Stripe confirms the refund — this isn't a manual follow-up step, it's an automated part of the billing system (`charge.refunded` → access reverts to Free immediately).

## Partial-season refunds

[POLICY — not decided here. E.g., whether a refund requested partway through the season is full, prorated, or unavailable past the window in the section above. This is a business decision.]

## Payment processing errors

If you were charged in error (e.g., a duplicate charge from a technical issue), contact [SUPPORT CONTACT EMAIL] and we'll investigate and refund genuine errors regardless of the window above.

---

**Open items for Mohamed (not invented, flagged for a real decision):**
- The refund window itself (§"Refund window") is undecided — this policy cannot honestly be called complete until that's chosen.
- Whether immediate access at checkout requires a specific consent/waiver checkbox for UK/EU statutory cooling-off rights — flagged for legal review, not resolved here.
- Partial-season/prorated refunds — undecided.
- Once real Stripe test credentials exist, the `charge.refunded` → access-revoked path described above should be exercised against Stripe's test-mode event simulator (not just the mocked unit tests already passing) before this policy goes live, so the policy's claim about automatic revocation is verified against the real integration, not just the code that's supposed to implement it.
