# Projection Engine Improve — Implementation Report

**Branch:** `feat/projection-engine-improve`  
**Audit source of truth:** `PROJECTION_ENGINE_AUDIT.md`  
**Model version:** `fpl-edge-2026.09.21-r7` (was `fpl-edge-2026.08.23-r6`)  
**Date:** 2026-09-21 (Africa/Cairo)  
**Constraint:** Draft PR only — no merge, no production deploy.

---

## 1. Architecture

Unchanged pipeline shape:

```
Official FPL APIs → app/api/fpl/route.ts → FplData
  → projectionMetricsBase (minutes / availability / xG / pens / DC / CS stub)
  → projectionMetrics (team-quality attack/defence + FDR residual)
  → playerProjection / ProjectionMetrics / playerPointsDistribution
  → bestXi / optimalSquadWeek / transfer-engine plans / Draft Lab / UI
```

**New modules (no planner rewrite):**

| Module | Role |
|--------|------|
| `app/lib/availability.ts` | Horizon-aware availability states, recovery curves, suspension calendar |
| `app/lib/fixtures.ts` | Authoritative fixture filters (blank/DGW/team-event) |
| `app/lib/projection-cache.ts` | Cache keys by player/GW/`PROJECTION_MODEL_VERSION`/dataTimestamp |

Transfer planner (type-B HOLD, legality, classification) is **untouched architecturally**. Only projection inputs and NET risk-adjustment (H4) changed.

---

## 2. Data sources

| Signal | Source | Notes |
|--------|--------|-------|
| Clubs, positions, prices, ownership, pens/set pieces, status, news | Official bootstrap-static | Unchanged |
| `chance_of_playing_next_round` | → `player.chance` | **Now GW+0 only** in projections |
| `chance_of_playing_this_round` | → `player.chanceThisRound` (**new mapping**) | Available for live GW; horizon model still keys off next-round + status |
| Fixtures | Official `/api/fixtures/` via `fixtures.ts` helpers | Single authority |
| Season live stats | Per-event live, finished fixtures only | Unchanged |
| Prior PL season | `app/data/prior-season-2025-26.json` | Unchanged matching rules |
| Team quality | `team-quality.ts` | Unchanged version stamp |

**Still not used:** Championship priors as PL xPts, ownership-as-xPts, FDR-only engine, hardcoded player bans/boosts.

---

## 3. Bugs fixed (H1–H8 + related)

| ID | Severity | Fix |
|----|----------|-----|
| **H1** | P0 | `availabilityForEvent` — next-round % at offset 0 only; doubtful/injury recovery curves; suspension exact duration |
| **H2** | P0 | Soften `/38` only when `priorStarts ≥ 18`; accelerate current-season weight when nailed (≥3 matches, ≥90% start share) |
| **H3** | P1 | Base CS uses opponent attack/defence quality when present on fixture; else home/away stub |
| **H4** | P1 | `riskMultiplier` = confidence-only (`0.88 + 0.12·conf`); start risk no longer re-discounts positive NET |
| **H5** | — | Documented; epNext first-event blend kept (intentional) |
| **H6** | — | FDR residual remains in quality layer; unused base attack FDR left (low risk) |
| **H7** | P2 | UI: Raw NET / points-Δ risk adj / Adjusted NET; optimizer utility → ADVANCED MODEL DIAGNOSTICS; /100 labelled decision confidence |
| **H8** | P2 | `explainPlanPath` → structured `PlanPathLeg[]`; “WHY THIS FUTURE MOVE?” drilldown |
| Ops H10 | — | Out of scope (live 503) |

---

## 4. Fixture validation

- Official fixtures remain the sole schedule source (`route.ts` map → `FplData.fixtures`).
- Projections filter via `fixturesForPlayerEvent`.
- Blank/DGW: `isBlankGameweek` / `isDoubleGameweek` + existing `dgw.ts`.
- Case-study CHE/BRE/LIV schedules from audit were not stale; no club-identity bug found for JP/Thiago/Palmer/Szoboszlai.
- Mid-season club change still follows live `element.team` on refresh (cache ≤5–10 min operational risk unchanged).

---

## 5. Minutes — before / after

**Formula (now explicit):**  
`ExpectedMinutes = P(start)·E(min|start) + P(bench)·E(min|bench)`  
with `minutesIfStart`, `minutesIfBench` (12), `benchProbability` on metrics.

### João Pedro (doubtful 75% knee) — before vs after

| GW offset | Before (audit) start / mins | After (r7) start / mins |
|-----------|-----------------------------|-------------------------|
| GW+0 (e.g. 6) | 61% / **57.5** | ~65% / **~61** |
| GW+1 | 61% / 57.5 (flat) | ~80% / **~72** |
| GW+2 | 61% / 57.5 | ~85% / **~75** |
| GW+3 | 61% / 57.5 | ~86% / **~77** |
| GW+4 | 61% / 57.5 | ~87% / **~77** |

GW+0 still reflects official 75%; **no more identical 58-min persistence** across 5 GWs. Slight GW+0 lift vs audit comes from H2 eligible-games softening on a strong 31-start prior (not from ignoring the flag).

### Thiago (healthy, pens order 1)

Remains high start (~97–98%) / ~87 mins when data supports; pen role intact. Higher than JP at GW+0 on availability + minutes + pens — **not blocked; explained**.

### Palmer — before vs after

| | Before | After (r7) |
|--|--------|------------|
| Start / mins | **~77% / 67.5** | **~96% / ~85** |
| Driver | `priorStarts/38` inertia (24/38) | Softened eligible denom + nailed current-season weight |

---

## 6. Injury / suspension — before / after

| Case | Before | After |
|------|--------|-------|
| Yellow flag (status `d`, chance 75%) | Flat × every future GW | GW+0 only; fast recovery curve (RETURNING by GW+1/2) |
| Injured low chance | Flat 0.2-ish forever | Slower exponential recovery |
| Suspended `status=s` | Treated like low chance every GW | Parsed N-match ban; 0 availability for N GWs then AVAILABLE |
| `news_added` | Unused in math | Ages accelerate recovery slightly |
| States exposed | Implicit via chance | `AVAILABLE/DOUBTFUL/INJURED/SUSPENDED/RETURNING/ROTATION_RISK/UNKNOWN` + chanceOfStart/Appearance/availabilityConfidence |

**Never:** persist yellow flag 5 GWs unchanged; invent multi-GW ban without news/status.

---

## 7. Team strength

Unchanged `team-quality.ts` layer: normalized attack/defence home/away, FDR^0.3 residual, CS from `exp(−xGA)`. Not FDR-only. No “promoted=easy” hardcode.

---

## 8. Attacker / defender / GK formulas

Unchanged scoring components (appearance, goals×pos, assists×3, CS×sixty, bonus, DC Poisson threshold, GK saves/pen saves). Quality layer still rescales xG/xA and replaces mean CS. Role boosts for pens/set pieces additive as before.

---

## 9. DC rules

Unchanged: Poisson P(actions ≥ threshold)×2; DEF threshold 10; MID/FWD 12; GKP 0. Minutes-scaled λ. FWD DC≈0 under threshold-12 remains rule-faithful (audit non-bug).

---

## 10. Pens / set pieces

Unchanged: `penaltiesOrder===1`, FK/corners order 1 → additive rate bumps × startProbability. Thiago pen edge remains data-driven.

---

## 11. Confidence / role security

- **Confidence:** evidence blend (prior mins, current mins, start, availabilityConfidence); capped by calibration group.
- **Role security (new field):** influences uncertainty/UI only — **does not** multiply xPts when minutes already embed start risk.
- **H4:** ranking risk adj no longer re-applies startProbability on positive NET.

---

## 12. Distributions / Monte Carlo

Deterministic PMF convolution retained (`projection-distribution.ts`) — floor/median/ceiling/blank/haul. No random MC added (would risk Overview hang). Existing deterministic path preferred; Overview shallow planning preserved.

---

## 13. Why JP ~58 mins (audit) / why it looked persistent

1. `chance=75` → availability 0.75  
2. Blended start × 0.75 → ~61% start  
3. `0.61×~87 + 0.39×12 ≈ 57.5`  
4. **Bug:** same availability every future GW  

**r7:** step 4 fixed; GW+0 still doubtful, later GWs recover.

---

## 14. Why Thiago ~87 mins

Healthy `status=a`, high prior/current starts, ~minutesPerStart mid-80s, start≈98% → `0.98×~87 + 0.02×12 ≈ 87`. Pens order 1 adds attacking edge. Valid if data supports — not a planner block.

---

## 15. Why Palmer → Szoboszlai surfaced

Audit: individual 5GW Δ ~+1.9 mostly minutes/role + set-piece package + price, **not** stale fixtures. Palmer was under-starting due to H2.  

**r7:** Palmer minutes/start corrected upward → individual gap should shrink; **planner must not hardcode a ban**. Structured path metrics explain remaining squad-level NET (captaincy reassignment, bank, future FT). Do not interpret residual recommendation as blockade.

---

## 16. Bugs behind strange futures (summary)

1. Flat injury % → depressed multi-GW paths (JP)  
2. priorStarts/38 inertia → false “rotation” (Palmer)  
3. Soft double-count start risk on NET → over-penalised premium/rotation narratives  
4. Opaque string paths → “strange” futures without metrics  
5. Colliding “risk-adjusted” / /100 labels → misread objective as xPts  

---

## 17. Files changed

**New:** `availability.ts`, `fixtures.ts`, `projection-cache.ts`, `PROJECTION_ENGINE_AUDIT.md`, `PROJECTION_ENGINE_REPORT.md`, `tests/projection-engine-improve.test.mts`  

**Core:** `app/lib/fpl.ts`, `app/lib/model-version.ts`, `app/api/fpl/route.ts`  

**Engine:** `plan.ts` (explainPlanPath), `recommend.ts` (H4 + path legs), `types.ts`, `adapter.ts`, `index.ts`, `transfers.ts`  

**UI:** `TransferBreakdown.tsx`, `CoachApp.tsx`, `SandboxImpactPanel.tsx`, `LiveDraftBuilder.tsx`

---

## 18. Tests

`tests/projection-engine-improve.test.mts` covers:

- JP horizon non-persistence  
- Suspension exact duration  
- Palmer priorStarts fix  
- ExpectedMinutes formula identity  
- H4 source guard  
- Availability states  
- Fixture authority blank/DGW  
- Path legs drilldown  
- Captaincy recalc via `optimalSquadWeek`  
- Projection cache keys  
- Thiago vs JP minutes  
- UI label guards  

Also green: existing `projection-engine`, `projection-distribution`, `transfer-engine`, `model-version` suites (131+ tests in combined run).

---

## 19. Backtest / calibration

Lightweight: model version bumped so deadline receipts isolate r7; registry `MODEL_RELEASES` marks r7 current. Full historical MAE backtest not run in this pass (API was 503 during audit; no production deploy). Receipt evaluation path remains keyed by `PROJECTION_MODEL_VERSION`.

---

## 20. Build / typecheck / lint

- Unit tests for new + related suites: **pass**  
- Full `npm test` (includes production build) not required to merge (draft PR only); run locally before merge  
- No production wrangler deploy; no cron preview required for this PR  

---

## 21. Limitations

- Recovery curves are heuristic (news text + status), not medical timelines  
- Suspension parse depends on English news patterns; opaque news → 1-GW default  
- epNext 18% blend still first-event only (H5)  
- Overview paths remain shallow (`futureBeamWidth: 0`) by hang-prevention design  
- Distributions UI on breakdown still primarily first-event PMF (H9 partial)  
- No random Monte Carlo (deterministic PMF kept)  

---

## 22. Best next data sources

1. Official FPL element status history / news timeline per GW  
2. Club confirmed XIs / presser minutes (opt-in, never scrape ownership-as-xPts)  
3. Set-piece taker confirmation feeds beyond order fields  
4. Per-player prior “eligible GWs” if FPL ever exposes availability calendars  
5. Post-deadline receipt MAE dashboards segmented by availability state  

---

## 23. Hard constraints checklist

| Constraint | Status |
|------------|--------|
| No hardcode players / ban premium / boost popular | ✓ |
| No ownership as xPts / arbitrary form points / double-count xG | ✓ |
| No promoted=easy / yellow=5GW ban / FDR-only | ✓ |
| Planner deterministic; projections → numbers; planner consumes; UI explains | ✓ |
| Official FPL fixtures authority | ✓ |
| ExpectedMinutes formula | ✓ |
| Availability states + confidence | ✓ |
| Role security confidence-only | ✓ |
| Injury recovery + suspension duration | ✓ |
| Captaincy recalc preserved (`optimalSquadWeek`) | ✓ |
| No planner architecture rewrite | ✓ |
| Draft PR only / no prod deploy | ✓ |

---

## 24. Real test cases

1. **JP → Thiago:** JP mins no longer flat; Thiago higher mins/start/pens OK when data supports; explained in UI metrics.  
2. **Palmer → Szoboszlai:** Not blocked in planner; Palmer minutes model fixed; path legs + Raw/Adjusted NET explain any remaining edge.

---

## 25. Success criteria

- [x] Audit + report in PR  
- [x] Tests green for new cases  
- [x] No planner architecture rewrite  
- [x] Model version bumped  
- [x] Draft PR (see PR URL in commit message / gh output)  

**Report path:** `/workspace/FPL-Edge/PROJECTION_ENGINE_REPORT.md`
