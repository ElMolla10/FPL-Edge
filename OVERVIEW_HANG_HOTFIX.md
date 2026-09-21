# Non-blocking type-B HOLD planner (post #56 re-entry)

## Root cause (PRs #53–#55)
Type-B `bestFuturePlan()` × full week-0 candidate matrix ran **synchronously** on Overview first paint. Unbounded (then insufficiently gated) squad×candidate×horizon search froze Chrome (`RESULT_CODE_HUNG`). Emergency revert #56 restored ~post-#52.

## This PR — hang prevention (do not reintroduce sync deep search on Overview)
1. **Planning mode split**
   - `mode: "shallow"` / `profile: "overview"` → forces `futureBeamWidth: 0` + `beamWidth: 0` + `OVERVIEW_TRANSFER_RULES` caps
   - `mode: "deep"` → full type-B budgets (Transfers / deferred Overview upgrade)
2. **Hard budgets** on every `recommendTransfers` call: `maxEvalCandidates`, `maxPlanNodes`, `planTimeBudgetMs`; on exhaust return best partial + HOLD
3. **Overview first paint**: shallow sync only (`useMemo`); optional deferred deep upgrade via `scheduleDeferred` (`requestIdleCallback` / timeout) — never deep on critical path
4. **Transfers**: deep ranking deferred off first paint (`scheduleDeferred`); page stays interactive
5. **CoachDock**: engine runs only when dock is **open** (not on every Overview paint)
6. **Invariant**: `PlanBudget.deepBeamInvocations === 0` on Overview/shallow path (regression tests)

## Type-B HOLD (preserved)
HOLD = no transfer now, bank FT, allow optimal future free transfers (not freeze forever). Rank MAKE/LEAN/ROLL/WATCH/AVOID vs HOLD baseline with risk-adjusted multi-GW NET. Authoritative FT/hit (0 FT → Hit −4). Diversity + legality kept.

## Web Worker note
Deep work uses idle-deferred main-thread chunks with hard caps rather than a Worker — FplData is large to structured-clone; budgets keep each deep pass well under hung-tab thresholds. Worker remains a follow-up if needed.
