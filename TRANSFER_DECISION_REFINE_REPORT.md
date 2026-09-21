# Transfer decision engine — second-pass refine (Chief report)

Branch: `refine/transfer-decision-engine`  
Projection weights: **unchanged**  
Merge: **do not merge until asked**

## (1) HOLD planner — VERIFIED type-B (was A; fixed)

**Before:** HOLD baseline froze the same squad for 5 GWs (type A).  
**After:** `bestFuturePlan()` in `app/lib/transfer-engine/plan.ts`:

- HOLD-now = no transfer this GW, bank FT, then greedy **free** transfers in later GWs when remaining-horizon gain clears margin.
- Transfer-now = force the week-1 move (exact hit), then same future free-transfer continuation.
- **TransferNetEV** = `plan(transfer-now).discountedTotal − plan(hold-now).discountedTotal`.

Tests A, E, G, `bestFuturePlan HOLD from 0 FT…` prove banking + later transfers.

## (2) BEST DECISION hero

Transfers Single moves opens with **BEST DECISION** (HOLD or MAKE), nets/cost/confidence/risk/reason, and **best alternative** when HOLD. Answers “Should I transfer?” first (`selectBestDecision`).

## (3) Separate FREE vs -4 HIT thresholds (BALANCED defaults in `rules.ts`)

| Band | FREE | HIT (−4) |
|------|------|----------|
| MAKE | ≥ +2.0 (+0.15 margin) | ≥ +4.0 (+0.35 margin; prefer +3GW & conf) |
| LEAN | +0.75–MAKE | +3.0–MAKE |
| WATCH | ~+0.25–LEAN | ~+0.5–LEAN |
| HOLD band | ±0.25 | ±0.25 |
| AVOID | < −0.25 | < 0 |

Configurable via `mergeTransferRules`; no call-site hardcoding.

## (4) shortTermNet&lt;0 && hit && modest long-term → WATCH not LEAN

`hit-short-negative-modest-long` gate. JP→Thiago-style (−4, 3GW −0.6, 5GW +2.1) → **WATCH** (test C). Strong long-term (≥ +5.0) can still escalate.

## (5)–(6) Detail transparency

Expanded detail shows: 5-GW raw NET vs HOLD, risk adjustment ×, risk-adj NET; structured **risk drivers**.

## (7) Confidence ≠ risk

UI keeps `87% confidence · Low risk` pattern; explicit note that confidence = evidence strength, risk = minutes/start volatility.

## (8) Hit detail breakdown

FT available / required / used / paid hit; next-GW hold vs transfer proj; immediate net; 3/5-GW NET vs HOLD; act-now vs wait-1-GW timing EV when applicable.

## (9) Renames (*VsHold)

Canonical: `threeGwNetVsHold`, `fiveGwNetVsHold`, `riskAdjustedFiveGwNetVsHold`.  
Legacy aliases kept: `netEv3`, `netEv5`, `riskAdjustedNet5`.

## (10) FT state transition tests

0→HOLD→1; 1→HOLD→2; 5→HOLD→5 (cap); 0+one hit→1; 2 use one→2. Covered in test E + `freeTransfersAfterDeadline`.

## (11) Decision margin

`freeMakeMargin` / `hitMakeMargin` — tiny positives do not MAKE; hits need larger clearance.

## (12) WATCH elevated

WATCH band widened; structured `reasonCodes`; hit+negative short-term→WATCH behaviour test (no hardcoded players).

## (13) Family grouping / diversity

Existing `diversifyRecommendations` caps same out/in; `groupTransferFamilies()` added for cluster visibility. Test I.

## Also shipped

- Primary list: BEST DECISION; MAKE/LEAN serious; WATCH important; AVOID collapsed.  
- Multi-signal deterministic classification.  
- Timing EV (act-now vs wait-one-GW) for hits.  
- Simplified future paths in detail.  
- Language: “modelled/expected” — no false precision claims beyond model.  
- Tests A–J + schema v2 + behavior HOLD+alt.  
- `priceOutlook` remapping from #51/#52 **untouched and still green**.

## Test result

`node --import tsx --test tests/transfer-engine.test.mts` → **36/36 pass**  
Related transfer UI/placeable suites → pass  
`tsc` clean for changed transfer-engine / CoachApp / transfers paths.
