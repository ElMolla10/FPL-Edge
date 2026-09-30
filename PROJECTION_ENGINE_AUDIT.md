# Projection / Expected-Points Engine — Audit Report

**Status:** DOCUMENT ONLY — no code changes, commits, or PRs in this pass.  
**Repo:** `/workspace/FPL-Edge` @ `main` (`00babec` — Merge PR #57 feat/nonblocking-typeb-hold)  
**Audit time:** 2026-09-21 ~15:51 EEST (Africa/Cairo)  
**Live app:** `https://fpl-edge.elmolla10.workers.dev/` (API returned **503** during this audit; projections were recomputed from the official FPL feed through the same mapping path as `app/api/fpl/route.ts`)  
**Model version:** `PROJECTION_MODEL_VERSION = "fpl-edge-2026.08.23-r6"` (`app/lib/fpl.ts:28`)

---

## Executive summary

1. **Single projection core:** GW expected points live in `projectionMetrics` / `projectionMetricsBase` (`app/lib/fpl.ts`). Transfer NET vs HOLD, Draft Lab, Pitch, and distributions all consume that same function (or `playerProjection` → `.xPts`).
2. **Data is official-FPL-first:** bootstrap-static + fixtures + per-event live stats; prior season from `app/data/prior-season-2025-26.json` matched by `id`+`code`. No scrape of non-FPL xG.
3. **João Pedro ~58 mins / 61% start is explained and reproducible:** FPL flag `status=d`, `chance_of_playing_next_round=75`, news *"Knee injury - 75% chance of playing"* → `availability=0.75` → `startProbability≈0.61` → `expectedMinutes≈57.5`. Reported **3.9 / 10.5 / 17.2** are **GW1 / Σ3GW / Σ5GW xPts**, not floor/median/ceiling.
4. **Critical data bug:** `chance_of_playing_next_round` is applied **unchanged to every future GW** — no recovery curve, no `news_added` decay. JP’s 75% knee flag depresses GW6–GW10+ identically.
5. **Palmer → Szoboszlai is mostly minutes/role math, not a stale fixture bug:** Palmer start ~77% / ~67.5 mins from **priorStarts/38 blending** (24/38), not injury; Szoboszlai ~97% / ~87 mins + pens/set pieces. Fixtures match official CHE/LIV schedule. Individual 5GW Δ ≈ **+1.9 xPts**; do **not** interpret as planner blockade.
6. **Captaincy after simulated transfers:** `optimalSquadWeek` re-picks C/VC from the post-transfer XI by xPts each GW (`app/lib/transfer-engine/squad-ep.ts`). Chip TC/BB handled separately in legacy `transfers.ts` baseline, not in type-B plan EP.
7. **Distributions exist and are deterministic** (PMF convolution, no `Math.random`) in `projection-distribution.ts`; UI shows floor/median/ceiling/blank/haul. Scenario sensitivity uses keyed scenarios; Overview uses **shallow** planning to avoid main-thread hang.
8. **UI clarity debt:** “Risk-adjusted objective”, “risk-adj 5-GW NET vs HOLD”, and “/100 overall” are three different numbers; `utilityChange` is often `null` from the transfer engine; future-path lists are string summaries and are empty/shallow on Overview.
9. **Soft double-count of minutes risk:** start/minutes already shrink xPts; transfer ranking then multiplies positive NET by `riskMultiplier(start, confidence)` again.
10. **Constraints respected in this audit:** no hardcoding players, no planner rewrite, no ban-premium / ownership-as-xPts / FDR-only redesigns proposed as fixes.

---

## 1. Architecture — how GW projections are computed and flow

### 1.1 Core pipeline

```
Official FPL APIs ──► app/api/fpl/route.ts GET ──► FplData
                                              │
                                              ▼
                         projectionMetricsBase(player, eventId, fixtures, firstEvent)
                                              │  (minutes, start%, xG/xA, appearance, pens,
                                              │   CS stub, bonus, DC Poisson, GK saves)
                                              ▼
                         projectionMetrics(...) ── team-quality attack/defence + FDR residual
                                              │
                    ┌─────────────────────────┼─────────────────────────┐
                    ▼                         ▼                         ▼
            playerProjection (.xPts)   ProjectionMetrics          playerPointsDistribution
                    │                  (UI / transfer rows)       (floor/median/ceiling/blank/haul)
                    ▼
     bestXi / optimalSquadWeek / createOptimizer.weekPlan / transfer-engine plans
```

| Concern | File | Key symbols |
|--------|------|-------------|
| Point estimate | `app/lib/fpl.ts` | `availability`, `playerCalibrationProfile`, `projectionMetricsBase`, `projectionMetrics`, `playerProjection`, `bestXi` |
| Team strength layer | `app/lib/team-quality.ts` | `buildTeamQualityProfiles`, `TEAM_QUALITY_MODEL_VERSION` |
| Distributions | `app/lib/projection-distribution.ts` | `playerPointsDistribution`, `pointsRange`, `blankProbability`, `haulProbability`, `buildPlayerEventOutcomeModel` |
| Transfer NET vs HOLD | `app/lib/transfer-engine/squad-ep.ts`, `plan.ts`, `recommend.ts`, `adapter.ts` | `optimalSquadWeek`, `bestFuturePlan`, `recommendTransfers`, `toTransferRow` |
| Legacy / Draft Lab | `app/lib/transfers.ts`, `app/lib/optimizer.ts` | `bestTransfers` → engine; `createOptimizer` / `evaluate` |
| Routes (multi-leg UI) | `app/lib/transfer-routes.ts` | Uses `playerProjection` + `ROLE_SECURITY_FLOOR` |
| UI surfaces | `CoachApp.tsx`, `TransferBreakdown.tsx`, `LiveDraftBuilder.tsx`, `LiveIntelligence.tsx`, `Pitch.tsx`, `SandboxImpactPanel.tsx` | xPts panels, floor/ceil, NET vs HOLD cards |

### 1.2 Flow into transfer-engine NET vs HOLD

1. `bestTransfers` (`transfers.ts:166`) → `bestTransfersFromEngine` (`transfer-engine`).
2. HOLD baseline = type-B `bestFuturePlan` with no week-0 transfer (bank FT; later free transfers when beam > 0).
3. Transfer-now = force week-0 leg (exact hit) then same future planner.
4. **`fiveGwNetVsHold = transferPlan.discountedTotal − holdPlan.discountedTotal`** (`recommend.ts:209`).
5. **`riskAdjustedFiveGwNetVsHold = fiveGwNetVsHold > 0 ? fiveGwNetVsHold * riskMultiplier(...) : fiveGwNetVsHold`** (`recommend.ts:226–227`).
6. Classification MAKE/LEAN/HOLD/WATCH/AVOID vs FREE/HIT thresholds (`rules.ts` / `classify.ts`).
7. Adapter maps engine rows onto `Transfer` UI type; paths: `transferNowPath` / `holdNowPath` from `summarizePlanPath`.

Overview uses `OVERVIEW_TRANSFER_RULES` (`futureBeamWidth: 0`, `beamWidth: 0`, 45ms budget) so HOLD still banks FT but **does not** search deep future free transfers — hang prevention, not a projection formula change.

### 1.3 UI surfaces that show projections

- **Overview / Transfers:** risk-adj NET vs HOLD, start%, expected minutes, path strings, risk drivers.
- **Player panel / Pitch:** per-GW `playerProjection`, minutes, start%.
- **TransferBreakdown:** out/in floor–ceiling–blank–haul from `playerPointsDistribution(outMetrics/inMetrics)` — **first-event metrics only** on the row’s stored `ProjectionMetrics`.
- **Draft Lab:** optimizer `scores.overall` (/100, capped 20–96), objective, per-player explanations, distributions.
- **Captain framing:** haul/blank probabilities on XI candidates.

---

## 2. Data sources

| Signal | Source | Mapping |
|--------|--------|---------|
| Clubs, positions, prices, ownership, pens/set-piece order, status, news, `ep_next`, FDR on fixtures | `https://fantasy.premierleague.com/api/bootstrap-static/` + `/api/fixtures/` | `app/api/fpl/route.ts` |
| Season minutes / xG / xA / starts / bonus / DC / saves | Per-event `/api/event/{id}/live/` aggregated only when **that player’s fixtures are `finished`** | `accumulateLiveStats` (`fpl.ts:74–92`) |
| Prior PL season | Static `app/data/prior-season-2025-26.json` (season label `2025/26`, competition Premier League) | Match `element.id` **and** `code`; else `priorSource: "position-baseline"` |
| Availability | `chance_of_playing_next_round` → `player.chance`; else status `a→1`, `d→0.72`, else `0.2` | `availability` (`fpl.ts:31`) |
| Team quality | Official strength_* normalized + current GF/GA/xG blend | `team-quality.ts`; stamped onto players + fixtures in route |
| Ownership | `selected_by_percent` | Used as **role-baseline prior for start rate when no PL prior**, and in differential philosophy — **not** as xPts |
| Cache | `next: { revalidate: 300 }`; response `Cache-Control: public, s-maxage=300, stale-while-revalidate=600` | route.ts:30, :252 |

**Not used:** Championship/non-PL stats as PL priors; scraping third-party xG; FDR-only engine (FDR is residual only in the quality layer).

---

## 3. Fixture module — authority and staleness risks

**Authoritative source:** official `/api/fixtures/` mapped once in `route.ts:232–248`. Downstream:

- Projections filter `fixtures` by `event === eventId` and `teamH/teamA === player.teamId`.
- Blanks/doubles/pending: `detectFixtureAnomalies` (`dgw.ts`) from the same array (`event === null` → pending).
- FDR matrix UI: `fixture-difficulty.ts` (display; uses team quality multipliers).

**Stale/wrong-club risks (ranked):**

| Risk | Evidence | Severity |
|------|----------|----------|
| Mid-season club change | Club comes from live `element.team`; fixtures use that id — generally safe if bootstrap is fresh | Low if cache ≤5–10 min |
| Cached FplData after transfer window | Client/`s-maxage=300` can lag official team moves briefly | Medium operational |
| Prior snapshot id collision | Guarded by `code` match (`route.ts:118–121`) | Mitigated |
| Blank/DGW | Handled by fixture count in base loop + `fixtureCount` in distributions | OK |
| Wrong club in projection | Would require wrong `teamId` on player or wrong fixture teams — not observed for JP/Thiago/Palmer/Szobo | Not found in case study |

Case-study fixtures (official, first future GW = **6** after GW5 window):

- CHE: BOU H, EVE A, TOT H, MUN H, SUN A  
- BRE: AVL A, LIV H, HUL A, NFO H, BHA A  
- LIV: MCI H, BRE A, BHA H, ARS H, CRY A  

No stale-fixture evidence for Palmer→Szoboszlai.

---

## 4. Expected minutes — formula, start vs bench, persistence

### 4.1 Formula (`projectionMetricsBase`, `fpl.ts:146–159`)

```
roleBaseline        = clamp(0.42 + selectedBy/100, 0.35, 0.82)
historicalStartRate = priorStarts/38   if PL prior else roleBaseline
blendedStartRate    = (historicalStartRate * rolePriorMatches + observedStarts)
                      / (rolePriorMatches + completedMatches)
startProbability    = clamp(blendedStartRate * availability − roleRisk, 0.03, 0.99)

minutesPerStart     = blend(priorMinutes/priorStarts, current minutes/starts)
                      each clamped to [58, 90]
expectedMinutes     = clamp(startProbability * minutesPerStart
                            + (1 − startProbability) * 12, 4, 90)
sixtyProbability    = clamp(startProbability * (mps≥72 ? 0.94 : 0.72), 0.02, 0.98)
```

- **Start vs bench:** non-start mass gets **12 expected minutes** (late sub), not 0. Appearance points: `(1−sixty)*start + sixty*2` (0/1/2 appearance model).
- **Same minutes vector every future GW:** `availability`, start blend, and minutesPerStart are **player-level**, not GW-specific (only fixtures/quality change per GW).

### 4.2 Unrealistic persistence across horizon

**Yes — by construction.** Any depressed `chance` or low blended start rate is copied to GW+1…GW+N. There is **no**:

- recovery curve from `news_added`,
- distinction between `chance_of_playing_this_round` vs next,
- GW-indexed availability,
- injury-duration model.

JP evidence: `start=61%`, `mins=57.5` on **every** of GW6–10 while FPL still shows 75% for *next* round only.

---

## 5. Availability / injury / suspension

| State | Handling |
|-------|----------|
| `chance !== null` | `chance/100` (FPL next-round %) |
| `status === "a"` | 1.0 |
| `status === "d"` | 0.72 **only if chance is null** |
| else (e.g. `"i"`, `"s"`, `"u"`) | 0.2 |

- **News / `newsAdded`:** stored and shown in UI; **not** used in minutes math.
- **Suspensions:** no separate multi-GW ban calendar — only whatever FPL puts in chance/status for next round.
- **Recovery curves / multi-GW duration:** **absent** (see §4.2, bug H1).

Scout risks: `scoutRisks.length * 0.05` capped at 0.18 subtracted from start probability (`fpl.ts:152–153`).

---

## 6. Role security / confidence — double-count?

| Layer | Uses start/minutes? | Uses confidence? |
|-------|---------------------|------------------|
| xPts build | Yes — via `startProbability`, `expectedMinutes`, `sixtyProbability`, roleBoost×start | Confidence is **not** a multiplier on xPts |
| `ROLE_SECURITY_FLOOR` | start≥0.55, mins≥45, conf≥0.35 hard gate | Yes (gate only) |
| Transfer quality score | Weighted mix of start, mins, confidence | Yes |
| `riskMultiplier` on positive NET | start×0.25 + conf×0.20 | Yes — **second discount** after xPts already embeds start/minutes |

**Verdict:** Not a literal “role × points × minutes” triple product inside `projectionMetrics`. There **is** a **soft double-count of minutes/start risk** between the point model and NET risk-adjustment (`recommend.ts:69–71`, `226–227`). Confidence is an evidence score, not a minutes multiplier — but it re-enters ranking.

---

## 7. Position formulas; DC; pens / set pieces

### 7.1 Per-fixture components (base loop, `fpl.ts:177`)

- **Appearance:** `(1−sixty)*start + sixty*2`
- **Goals:** `xG90 * expectedMinutes/90 * homeAwayAttack (+ roleBoost*start)` × (FWD 4 / MID 5 / DEF|GKP 6)
- **Assists:** same minutes scaling × 3 (+ set-piece bump×start)
- **CS (base stub):** `csProb = clamp(0.31*(home?1.05:0.94), …)` × CS points (GKP/DEF 4, MID 1, FWD 0) × `sixty` — **opponent-agnostic in base**
- **Bonus:** `bonusPerStart*start*attack + 0.45*(xG+xA)`, clamp 0–1.6
- **DC:** `poissonAtLeast(dcPerStart * expectedMinutes/90, threshold) * 2` with threshold DEF 10 / MID&FWD 12; GKP 0
- **GK saves:** difficulty-scaled saves/3; pen-save expectation `priorPenSaveRate * 0.22 * 5`

**Pens / set pieces:** `penaltiesOrder===1`, `directFreekicksOrder===1` or `cornersOrder===1` → additive xG/xA role boosts (not full shot models).

### 7.2 Quality layer (`projectionMetrics`, `fpl.ts:184–213`)

Rescales xG/xA by `fixtureAttackMultiplier = teamAttack/opponentDefence * FDR^0.3`; replaces CS with Poisson-ish `exp(−xGA)` from defence matchup; adjusts bonus; blends delta into xPts (82% component weight when `epNext` blended on first event).

### 7.3 Official ep_next blend

On **first** future event only: `0.82 * model + 0.18 * epNext` if `epNext > 0` (`fpl.ts:178`, `:211`).

---

## 8. Captaincy after simulated transfers

**Yes — recalculated every week on the simulated squad.**

`optimalSquadWeek` (`squad-ep.ts:20–66`): enumerate legal formations → XI by position xPts → captain = top XI xPts, vice = second → `grossEp = sum(XI) + captain` (standard 2×). Chips (TC/BB) are **excluded** from type-B plan EP (comment at lines 15–18).

UI captain resolution (`captaincy.ts`) is separate (stored / manager / model) for Team/Overview display — not the planner’s EP captain.

---

## 9. Monte Carlo / distributions

| Feature | Status |
|---------|--------|
| Floor / median / ceiling | Yes — PMF quantiles 0.1 / 0.5 / 0.9 |
| Blank (≤2) / haul (≥10) | Yes |
| Random Monte Carlo | **No** — deterministic convolution + keyed scenario uniforms in sensitivity |
| Sync blocking | Overview: shallow beam + time budget; decision-confidence worker exists; `LiveIntelligence` comments note ~950ms main-thread haul work historically |

Distributions are **reconciled** to `projectionMetrics.xPts` mean in `buildPlayerEventOutcomeModel` (thinning/additive) for sensitivity — audit assumptions listed in `projection-distribution.ts:355–361`.

---

## 10. Caching / model versioning

- **API cache:** 300s SWR (above).
- **In-request caches:** `Map` projection caches in `transfers.ts`, `optimizer.ts`, `recommend.ts` (per invocation, not durable).
- **Version string:** `PROJECTION_MODEL_VERSION`; release notes in `model-version.ts` (r6 = multi-GW routes). Deadline receipts are intended to freeze this version for accuracy reports.
- **Team quality:** separate `team-quality-2026.08.23-r1`.

---

## 11. Known UI issues (projection-adjacent)

| Issue | Evidence | Notes |
|-------|----------|-------|
| “Risk-adjusted objective” vs NET vs /100 | `TransferBreakdown.tsx` shows `utilityChange` (optimizer Δ) often **"—"** (`adapter` sets `null`); Sandbox shows objective **and** `/100`; Transfers hero shows risk-adj NET vs HOLD | Three different concepts; labels collide |
| /100 overall never 100 | `optimizer.ts` clamps overall to **[20, 96]** | “95/100” is near the artificial ceiling |
| Future-path explanation objects | Paths are **`string[]`** from `summarizePlanPath` (`plan.ts:360–368`), not structured step objects with EP/hits/metrics | UI only renders if `transferNowPath?.length` |
| Overview shallow paths | `futureBeamWidth: 0` → future steps mostly HOLD FT-banking; less explanatory depth | By design for hang fix |
| TransferBreakdown distributions | Built from **GW1** `outMetrics`/`inMetrics` only, not 5GW path | Can disagree with 5GW NET narrative |
| Live workers.dev | **503** during audit | Ops/deploy; not a formula bug |

---

## 12. Real cases (read-only)

### 12.1 João Pedro (165, CHE FWD) vs Thiago (106, BRE FWD)

**Official flags (bootstrap, audit time):**

| | João Pedro | Thiago |
|--|------------|--------|
| Status / chance | `d` / **75** (“Knee injury - 75% chance of playing”) | `a` / null |
| Price | £7.8m | £7.8m |
| Mins / starts (season live agg.) | 360 / 4 | 442 / 5 |
| Prior mins / starts | 2658 / 31 | 3282 / 37 |
| Penalties | none | **order 1** |
| Ownership | 66.4% | 9.0% |

**Recomputed with production `projectionMetrics` (firstEvent=6):**

| GW | JP xPts | JP start / mins | Thiago xPts | Thiago start / mins |
|----|---------|-----------------|-------------|---------------------|
| 6 | **3.89** | 61% / 57.5 | **4.37** | 98% / 87.4 |
| 7 | 3.02 | same | 4.95 | same |
| 8 | 3.58 | same | 4.84 | same |
| 9 | 3.55 | same | 5.46 | same |
| 10 | 3.12 | same | 4.60 | same |
| **Σ3 / Σ5** | **10.49 / 17.16** | | **14.16 / 24.22** | |

Matches reported **~3.9 / 10.5 / 17.2** vs **~4.4 / 14.2 / 24.2** and **mins 58 vs 87**, **start 61% vs 98%**.

**Where JP 58 mins comes from:**

1. `availability = 75/100 = 0.75` (`fpl.ts:31`, route maps `chance_of_playing_next_round`).
2. Blended start ≈ 0.81 from prior 31/38 + current starts.
3. `startProbability = 0.81 × 0.75 ≈ 0.61`.
4. `minutesPerStart ≈ 87` (clamp blend of prior/current).
5. `expectedMinutes = 0.61×87 + 0.39×12 ≈ 57.5` → UI rounds to **58**.

**Persists unrealistically:** identical 61% / 57.5 across GW6–10 while the FPL field is only “next round”. Thiago’s edge is mostly **availability + minutes + pen role**, not a bogus club/fixture.

### 12.2 Palmer (154, CHE MID) → Szoboszlai (368, LIV MID)

| | Palmer | Szoboszlai |
|--|--------|------------|
| Status / chance | `a` / 100 | `a` / null |
| Price | £9.7m | £7.0m |
| Prior starts | **24**/38 → historical start ~0.63 | **36**/38 |
| Modeled start / mins | **77% / 67.5** | **97% / 86.7** |
| Pens / set pieces | pen 1; FK order 2 (not 1 → no setPieceRole) | pen 1; corners 1; FK 1 → **setPieceRole** |
| GW6 xPts | 4.89 (BOU H) | 4.43 (MCI H — tough atk mul 0.81) |
| Σ5 xPts | **21.92** | **23.80** (Δ **+1.88**) |

**Interpretation for later phases (not a planner block recommendation):**

- Not a wrong-club / stale-fixture bug (schedule matches official API).
- Palmer’s “rotation” is largely **priorStarts/38 inertia** + slow current weight (5 starts vs `rolePriorMatches=8`), despite chance=100 and solid current starts.
- Szoboszlai wins on **minutes security + set-piece package + price**; GW1 can still favour Palmer on fixture.
- Squad-level NET vs HOLD / captaincy reassignment / bank from £2.7m released can dominate individual Δ — investigate with structured path metrics, don’t hardcode a ban.

---

## 13. Bug / hypothesis list (severity-ranked; data first)

| ID | Severity | Hypothesis | Evidence |
|----|----------|------------|----------|
| **H1** | **P0 — Data/availability** | Next-round injury % applied to entire horizon | `availability` (`fpl.ts:31`); used in every `projectionMetricsBase` call; JP identical mins GW6–10; `newsAdded` unused in math |
| **H2** | **P0 — Minutes model** | `priorStarts/38` permanently taxes players with incomplete prior seasons (Palmer 77% forever early season) | `fpl.ts:147–153`; Palmer chance=100 yet start=77% after 5/5 current starts |
| **H3** | **P1 — Base CS** | Base CS ignores opponent; quality layer patches later — blank/haul PMFs sensitive to order of operations | Base `csProb` home/away only (`fpl.ts:177`); quality replaces mean CS (`:198–205`) |
| **H4** | **P1 — Ranking** | Soft double-count: minutes already in xPts, then `riskMultiplier(start,conf)` on positive NET | `recommend.ts:69–71`, `:226–227` |
| **H5** | **P1 — epNext** | 18% blend only on firstEvent; can disagree with pure model on GW1 vs later | `fpl.ts:178`, `:211` |
| **H6** | **P2 — FDR in base** | `difficultyFactor` unused in attack xG base loop (only GK save scaling + quality residual) | Declared `:30`; attackFactor home/away only in `:177` |
| **H7** | **P2 — UI** | Colliding “risk-adjusted” labels; `utilityChange` null on engine rows; /100 cap 96 | `adapter.ts:135`; `optimizer.ts` overall clamp; `TransferBreakdown.tsx` |
| **H8** | **P2 — Paths** | Future paths are opaque strings; Overview shallow empties explanatory depth | `plan.ts:360–368`; `OVERVIEW_TRANSFER_RULES` |
| **H9** | **P2 — Distributions UI** | Breakdown shows GW1 PMF while decision is 5GW NET | `TransferBreakdown.tsx:22–23` uses row metrics from first event |
| **H10** | **P3 — Ops** | Live `/api/fpl` 503 during audit | curl against workers.dev |

**Explicit non-bugs / out of scope for “hardcode” fixes:** Thiago > JP while JP is flagged 75%; Szoboszlai individual edge from minutes+set pieces; FWD DC≈0 under threshold-12 Poisson (harsh but rule-faithful).

---

## 14. Proposed fix plan (later phases — **do not implement now**)

Aligned to Chief order. **Do not change transfer-planner architecture** (type-B HOLD, legality, classification shells stay).

### Phase A — Data (first)

1. **Horizon-aware availability:** map FPL next-round chance to GW0 only; decay toward healthy baseline using `news`/`news_added` heuristics or status transitions — **never** “yellow flag = 5 GW ban”.
2. Ingest `chance_of_playing_this_round` separately if useful for live GW.
3. Ensure fixture/team identity checks remain on every refresh; surface `dataIntegrityWarnings` when prior `code` mismatches spike.

### Phase B — Minutes / availability / fixtures

1. Replace or damp `priorStarts/38` with a prior that doesn’t assume 38 eligible starts (e.g. starts/appearances, or Bayesian with stronger current-season weight after N starts).
2. Keep bench sub minutes explicit; consider GW-specific minutes only via availability schedule, not ad-hoc form points.
3. Fixture anomalies: keep `dgw.ts` as sole blank/DGW detector; add UI copy when pending `event:null` fixtures exist.

### Phase C — Justified math (no double-count / no ownership-as-xPts)

1. Decide single home for minutes risk: either encode fully in xPts **or** in NET multiplier — not both at full strength.
2. Document / optionally tighten base CS vs quality-layer CS so PMF mean stays reconciled (already partly handled).
3. Revisit pen/set-piece boosts as additive rate bumps (keep; don’t invent ownership xPts or “promoted=easy”).

### Phase D — Future-path explanation UI

1. Replace/augment `string[]` paths with structured steps: `{eventId, action, out, in, hitCost, ftBefore/After, weeklyGross, netVsHoldSlice}`.
2. Always show transfer-now vs hold-now totals that reconcile to `fiveGwNetVsHold`.
3. Deep mode (Transfers) full beam; Overview remains shallow but should say so.

### Phase E — UI clarity

1. Rename labels: **Risk-adj NET vs HOLD** ≠ **Optimizer objective** ≠ **Team rating /100**.
2. Stop showing “—” objective unless Draft Lab utility is intentionally computed; don’t imply missing math.
3. Disclose /100 cap (96) or rescale.

### Phase F — Tests / backtest

1. Unit: availability decay schedule; Palmer-like priorStarts inertia; JP-like next-round-only flag.
2. Golden: JP/Thiago-style 1/3/5 GW sums against frozen FplData fixtures.
3. Receipt backtest already keyed by `PROJECTION_MODEL_VERSION` — bump version when semantics change.
4. No planner architecture rewrite in tests — assert projection inputs/outputs only.

---

## Appendix A — Key formulas (quick reference)

```
availability     = chance/100 | status a→1 | d→0.72 | else 0.2
startProbability = clamp(blendedStartRate * availability − roleRisk, 0.03, 0.99)
expectedMinutes  = clamp(startP * minutesPerStart + (1−startP)*12, 4, 90)
xG_fixture       = xG90 * expectedMinutes/90 * attackHomeAway + roleBoost*startP
xPts_event       ≈ Σ_fixtures(appearance + xG*G + xA*3 + CS + bonus + DC + saves)
                   then quality rescale; firstEvent blend 82/18 with epNext
riskAdjNet5      = net5>0 ? net5 * clamp(0.55 + 0.25*start + 0.2*conf, 0.55, 1) : net5
```

## Appendix B — Confirmation

- Audit file path: **`/workspace/FPL-Edge/PROJECTION_ENGINE_AUDIT.md`**
- **No application code was modified** in this pass; **no commit / PR**.
- Working tree aside from this new audit file: pre-existing untracked `qa-screenshots/`, `wrangler.pr57.jsonc` only.

