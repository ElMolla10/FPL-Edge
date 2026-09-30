# FPL Edge shell / IA redesign — Review package

**For:** Mohamed  
**Status:** Draft stack only — **do not merge until Mohamed says go.** No prod deploy.  
**Date:** 2026-09-21 (Africa/Cairo)  
**Against:** Kevin locked scope + Mohamed §8 A–E + `SHELL_IA_FEASIBILITY.md`

---

## Already on prod

| PR | What shipped |
|----|----------------|
| **#60** `shell/chrome-strip` | Sticky chrome: Wordmark · GW countdown · Sign in/Account. Deduped wordmark / coach pill / header season-pass / second freshness banner. |
| **#61** CoachDock smoke hotfix | Test fix after chrome-strip (CoachDock removal). |

`main` baseline for the draft stack is post-#60/#61.

---

## Draft stack — merge order (when Mohamed says go)

Merge **bottom-up** (each PR’s base is the previous head):

1. **#62** `shell/phone-tabs-safe-area` → `main`  
2. **#63** `shell/overview-3-metrics` → #62  
3. **#64** `shell/transfers-presentation` → #63  
4. **#65** `ia/desktop-nav` → #64  
5. **#66** `ia/phone-squad-transfers` → #65  
6. **#67** `ia/templates-squad-players-coach` → #66  
7. **#68** `density/fixtures-tables-research` → #67  
8. **#69** `density/signed-in-chrome` → #68 *(optional Mohamed C slice)*

Do **not** merge out of order. Prefer preview Workers per PR if needed; **never** prod until explicit go.

---

## Per-phase one-liners

| Phase | PRs | One-liner |
|-------|-----|-----------|
| **Prod** | #60 + #61 | Sticky strip chrome + test hotfix. |
| **1 — Shell** | #62 → #64 | Phone 5-tab dual-active + safe-area; Overview ≤3 metrics (shallow path); Transfers one badge / metrics once / denser why. |
| **2 — IA + templates** | #65 → #67 | Desktop primary Overview·Squad·Transfers·Final check·Players·Coach; phone Transfers under My Squad; Squad pitch-first; Players sticky/collapsed; Coach trust. |
| **3 — Density** | #68 → #69 | Denser fixtures + tables + Research disclosure + lime leftovers; optional compact signed-in account chip (season pass in More/account only). |

---

## Freeze notes

- **Route planner card CONTENT frozen (E).** Chrome/wrappers/spacing OK; do not edit solver copy, ranking fields, or card body components except wrappers.
- **Overview shallow budgets.** Do not reintroduce deep `bestTransfers` / full planner on first paint.
- **UI-only.** No planner / projection / FT / engine / Paymob SKU changes.
- **Season pass:** placement only (More / account) — no new PRO features.

---

## QA checklist (before any merge)

- [ ] **Phone safe-area:** content never under tab bar; sheets clear home indicator (Safari + Capacitor if used).
- [ ] **Overview no hang:** interactive on first paint; shallow recommendation path; no deep planner sync.
- [ ] **Desktop nav:** primary set Overview · Squad · Transfers · Final check · Players · Coach; Research/PRO disclosures only.
- [ ] **Phone tabs:** Home · My Squad · PRO · Coach · More; Transfers via My Squad segments (not a 6th tab); Final check via More.
- [ ] **Transfers:** single MAKE/HOLD badge; metrics once; Route planner **content** unchanged vs pre-shell.
- [ ] **Squad:** Pitch default; List secondary.
- [ ] **Players:** filters collapsed until Show filters; sticky table header.
- [ ] **Density (#68):** fixtures/tables denser; Research/PRO disclosure polish; lime only on primary decision + active nav + live/fresh dots.
- [ ] **Signed-in (#69):** compact account chip; season pass not a header CTA (More/account only).
- [ ] **No light theme** / no lime CTA bleed on secondary buttons.

---

## Explicit hold

**Do not merge this stack (or any Phase 3 PR) until Mohamed says go.**  
Draft PRs are for review + preview only. No prod deploy from this package.

---

## Links (draft)

- Feasibility: `SHELL_IA_FEASIBILITY.md` (local / workspace; not required on tip)  
- Tip branch with this doc: `density/signed-in-chrome`  
- Draft PRs:
  - https://github.com/ElMolla10/FPL-Edge/pull/62
  - https://github.com/ElMolla10/FPL-Edge/pull/63
  - https://github.com/ElMolla10/FPL-Edge/pull/64
  - https://github.com/ElMolla10/FPL-Edge/pull/65
  - https://github.com/ElMolla10/FPL-Edge/pull/66
  - https://github.com/ElMolla10/FPL-Edge/pull/67
  - https://github.com/ElMolla10/FPL-Edge/pull/68 — Phase 3 density
  - https://github.com/ElMolla10/FPL-Edge/pull/69 — Phase 3 signed-in chrome + this doc
