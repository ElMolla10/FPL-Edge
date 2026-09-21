# P0 Hotfix — Overview / Transfers hang after #53+#54

## Root cause
Type-B `bestFuturePlan()` scanned **every** squad×candidate pair for **every** future GW, and `recommendTransfers()` ran that full plan for **every** week-0 legal pair before applying `limit`. Overview called this synchronously on first paint (limit 12 still evaluated the full matrix). Chrome main-thread freeze → `Page Unresponsive` / `RESULT_CODE_HUNG`.

`beamWidth` existed in rules but was unused.

## Fix (preserve type-B HOLD semantics)
1. **Hard budgets** on every `recommendTransfers` call:
   - `maxEvalCandidates` (default 40) — cheap pre-rank, then full-plan only top N
   - `maxPlanNodes` (default 6000)
   - `planTimeBudgetMs` (default 180ms)
2. **`futureBeamWidth`** (default 8) — cheap-rank then beam full squad-EP compares in future GWs; memoized remaining EP
3. **Overview profile** `OVERVIEW_TRANSFER_RULES`: `futureBeamWidth: 0`, `maxEvalCandidates: 8`, `planTimeBudgetMs: 45`, pool 6, limit 1  
   - Still **type-B FT banking** on HOLD (0→1, etc.)  
   - Skips deep future free-transfer search on first paint (documented shallow continuation)
4. **Overview + CoachDock**: `useMemo`, `limit: 1`, `{ profile: "overview" }`
5. **Transfers page**: defer engine off first paint via `requestIdleCallback` / `setTimeout(0)`; full budgeted type-B still runs after paint
6. **Guard tests**: runaway budget abort + overview profile latency

## Not reverted
- Type-B HOLD planner (FT banking + future free transfers on full Transfers path)
- FREE vs HIT thresholds, BEST DECISION, NET-vs-HOLD ranking

## Follow-up (optional)
Restore deeper Overview quality asynchronously after first paint without blocking interactivity.
