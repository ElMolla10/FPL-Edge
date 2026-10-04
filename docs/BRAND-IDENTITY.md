# FPL Edge visual identity (implementation notes)

Source of truth: the supplied identity pack (BRAND-GUIDE, `design-tokens.json`, `brand.css`). Where the written guide and the direction screenshot differ, the guide wins.

## Tokens (`app/globals.css`, the only place tokens are defined)

| role | dark (default) | light |
|---|---|---|
| `--canvas` / `--surface` / `--surface-raised` | `#121614` / `#18201B` / `#1F2A23` | `#F7F7F5` / `#FFFFFF` / `#EDF2EC` |
| `--border` | `#35443A` | `#D7DFD8` |
| `--text` / `--text-muted` | `#F7F7F5` / `#B3BEB5` | `#121614` / `#526057` |
| `--lime` (actions, brand, selected rule) with `--on-lime` ink | `#B9F43B` / `#121614` | same |
| `--accent-text` (lime as *text*) | `#B9F43B` | `#121614` (never lime text on white) |
| `--positive-text` / `--warning-text` / `--negative-text` | `#66D9A0` / `#F5C76B` / `#FF8D91` | `#0B6B3A` / `#7A5200` / `#B3261E` |
| `--selected-bg/-text` (segmented controls, active tab) | chalk pill | ink pill |

Also: `--fdr-1..5` + `--fdr-ink` (fixture difficulty chips, always number + label + colour), `--success/warning/danger/info-bg`, `--shadow-float` (floating layers only), `--scrim`, `--font-ui` (Inter), `--font-display` (Space Grotesk), radii `--r-control 8 / --r-card 16 / --r-sheet 24 / --r-badge 4`, `--sidebar-w 224`, `--content-max 1280`, `--gutter 32`, `--tap 44`.

Old -> new (all call sites migrated, compatibility aliases removed): `--paper/--surface-card -> --surface`, `--surface-sunken -> --surface-raised`, `--line/--hairline/--wline -> --border`, `--ink/--ink2 -> --text/--text-muted`, `--green/--rise -> --positive-text`, `--fall -> --negative-text`, `--surface-inverse` family -> normal surfaces (no black islands in the light theme), hard-coded hex -> tokens.

## Fonts (self-hosted, same-origin)

`public/fonts/` holds Inter (static 400 and 600 latin instances cut from the variable font, plus the variable latin-ext file for rare accents) and Space Grotesk (variable, latin + latin-ext) woff2 with their OFL licences. `@font-face` uses `font-display: swap` and `unicode-range`; the two latin files are preloaded so the swap happens before first paint. (Static Inter instances instead of the variable file: the variable latin file added ~70 ms of main-thread layout on the Overview in the responsiveness gate. Metric-matched `local()` fallback faces were tried and dropped: font matching for `local()` sources cost ~60 ms of main-thread layout on the Overview in the responsiveness gate.) Only the three latin files used above the fold are preloaded (was 10 files: 7 Inter subsets + 3 Fraunces). `next/font/google` and the unused Fraunces are removed. No Google Fonts request, CSP unchanged.

## Theme

Dark is the default for every first visit, regardless of OS setting. The nonce'd inline script in `<head>` (`app/lib/theme.ts`) reads only `fpl-edge-theme-v2`, written **only by a click on the toggle**. The old `fpl-edge-theme` key is deliberately ignored, so anyone who was auto-themed starts dark. `ThemeToggle` (`aria-pressed`, label "Light theme", 44px) is in every public page header, the sidebar and the mobile More sheet; other tabs follow through the `storage` event.

## Logo

The supplied artwork is used unchanged: `public/brand/primary-logo-1024.png` is a byte copy of the supplied file; 96/192px are plain resamples (the existing app icons already matched the supplied logo). Rendered only through `BrandMark` (>=48px, no container, never recoloured), stays a dark tile in both themes. Narrow header uses the typeset wordmark. `public/og.png` is regenerated: exact logo on `#121614`, "Your next move. Clear." (the previous OG art had reversed colours).

## Weekly call badge: engine state -> display word (display only, `app/lib/decision-badge.ts`)

| engine (unchanged, still used by analytics/tests) | badge | user copy |
|---|---|---|
| `MAKE` | MAKE | the move, "Review transfer" |
| `LEAN`, `WATCH` | WATCH | the candidate move is shown, marked marginal |
| `HOLD`, `KEEP` (Wildcard), `ROLL`, `AVOID` | KEEP | "Keep this week - no transfer" / "Keep your Wildcard squad" |

`plainReason()` rewords the engine's sentence only ("vs HOLD" -> "vs keeping", "risk-adj" -> "risk-adjusted", "5-GW NET" -> "5-gameweek net"); numbers are untouched. Confidence is the engine's own `confidenceIn` (0-1) shown as a percentage with a High/Medium/Low word (>=75% / >=50% / below) and described as evidence strength, not a guarantee. Nothing in `rankTransfersForBestDecision`, `selectBestDecision` or the shallow-first Overview render changed.

## Navigation reconciliation

* Desktop sidebar keeps the PRO lime locked dropdown directly under the primary items (Mohamed's earlier preference) and the Research disclosure.
* The phone bottom bar follows the guide: Home, Squad, Transfers, Coach, More. Final check, Players, Research and the PRO tools (with lock icons when not on the season pass) live in the More bottom sheet (focus trap, Escape, focus restore); upgrade is contextual, not a central PRO button.
* Collapse breakpoint moved from 850px to 1023/1024px (guide).

## Deviations from the guide

* Dark first visit ignores `prefers-color-scheme` (explicit instruction overrides the guide).
* Selected segmented controls use a chalk (dark) / ink (light) pill rather than lime, so lime stays for actions and the single recommendation rule.
* The decision-card CTA "Review transfer" opens Final check (the existing review step); "Compare options" opens Transfers.
* The matching existing test that banned "Model confidence" copy was relaxed (per-player/route confusions stay banned) because the guide asks for a separate "Model confidence" card.

## Contrast (WCAG 2.x, computed from the real tokens by `tests/brand-contrast.test.mts`)

| pair (foreground on background) | dark | light |
|---|---|---|
| `--text` on `--canvas` | 17.02:1 | 17.02:1 |
| `--text` on `--surface` | 15.52:1 | 18.25:1 |
| `--text-muted` on `--canvas` | 9.52:1 | 6.18:1 |
| `--text-muted` on `--surface` | 8.68:1 | 6.63:1 |
| `--text-muted` on `--surface-raised` | 7.75:1 | 5.84:1 |
| `--on-lime` on `--lime` | 13.96:1 | 13.96:1 |
| `--accent-text` on `--canvas` | 13.96:1 | 17.02:1 |
| `--accent-text` on `--surface` | 12.74:1 | 18.25:1 |
| `--positive-text` on `--surface` | 9.51:1 | 6.61:1 |
| `--warning-text` on `--surface` | 10.52:1 | 6.92:1 |
| `--negative-text` on `--surface` | 7.51:1 | 6.54:1 |
| `--success-text` on `--success-bg` | 6.99:1 | 5.79:1 |
| `--warning-text` on `--warning-bg` | 7.64:1 | 6.28:1 |
| `--danger-text` on `--danger-bg` | 5.88:1 | 5.52:1 |
| `--selected-text` on `--selected-bg` | 17.02:1 | 17.02:1 |
| `--fdr-ink` on `--fdr-1` | 10.43:1 | 10.43:1 |
| `--fdr-ink` on `--fdr-3` | 13.97:1 | 13.97:1 |
| `--fdr-ink` on `--fdr-5` | 8.23:1 | 8.23:1 |
| `--focus` on `--canvas` | 17.02:1 | 17.02:1 |
| `--focus` on `--surface` | 15.52:1 | 18.25:1 |

## Verification and performance (final build)

Screenshots: `docs/screenshots/brand-identity/` (contact sheets per theme and width, selected full-size WebP, a few "before"). Full PNG sets are kept outside the repo.

| Check | Result |
|---|---|
| `npm test` | 11/11 and 1086/1086 pass |
| `tsc --noEmit` | clean |
| `npm run build` | OK |
| Lint ratchet | 200 errors vs 208 baseline (baseline updated) |
| Unused-CSS audit | 0 dead rules |
| CSP (18 views, all routes, 390 and 1440, signed-in empty state) | 0 violations, inline scripts nonce'd |
| Failed requests | only the intentional 404 page |
| Theme | fresh `colorScheme: light` starts dark; toggle persists across reload/routes/tabs; old key ignored |
| Overflow / tap / contrast audit (390/768/1440, both themes) | 0 findings at 768 and 1440; at 390 only inline support-email links (22px) and the Draft Lab remove-player × (14px visible, 44px hit area) |

Performance, same machine, baseline = origin/main:

| Metric | Before | After |
|---|---|---|
| First-load CSS `/` raw/gz | 30,915 / 7,581 | 30,781 / 7,589 |
| First-load CSS signin/signup/pay/404/terms | 24,932 / 6,114 | 24,246 / 6,063 |
| Total JS in dist | 865,799 B (58 files) | 851,690 B (57 files) |
| Font preloads | 10 | 3 |
| Mobile FCP/LCP (Slow-4G, 4x CPU, median of 5) `/` | 1136 / 1136 | 684 / 684 |
| `/signin` | 1040 / 1040 | 656 / 656 |
| `/pay` | 1144 / 1144 | 684 / 684 |
| `/?demo=1` | 1140 / 4752 | 756 / 3876 |
| Overview gate longest main-thread block | 154 ms | 237 ms (limit 500, no freeze) |
| Overview gate max interaction frame delay | 33 ms | 337 ms |
| Overview second visit | 127 ms | 113 ms |

The Overview interaction delay is a regression versus baseline (still under the gate's 500 ms limit).
