# FPL Edge

Complete source snapshot of the current FPL Edge implementation.

## Snapshot identity

- Sites project: `fpl-edge`
- Sites project ID: `appgprj_6a883fd49dbc81919b1dd1ccccf9e728`
- Hosted version: `v15`
- Source commit: `8fe6bbaa10f86d80c56b2933102eb946e4b0d419`
- Commit: `Add saved captain and vice-captain controls`
- Commit time: `2026-08-21T17:20:01+03:00`
- Current hosted URL: `https://fpl-edge.moehab.chatgpt.site`

The application source in this package is copied directly from that commit. The original Sites starter documentation is preserved unchanged as `README.SITES.md`; this file adds project-specific setup and architecture notes.

## What is included

- Full Next.js/Vinext/React frontend and styling
- Server-side FPL data, team-import, and history API routes
- FPL projection and squad-optimization logic
- Squad builder, football-pitch UI, captain and vice-captain controls
- Player explorer, fixtures, news, chips, points model, and history experiences
- Drizzle/D1 data-access scaffolding and example schema
- Cloudflare Worker entry point and image optimization
- Sites/Vite/Cloudflare build configuration
- Public images and SVG assets
- Tests, scripts, exact dependency lockfile, and TypeScript configuration

Generated dependencies and caches are intentionally not included: `node_modules`, `dist`, `.next`, `.sites-runtime`, `.wrangler`, and Git object history. They are reproducible from the committed lockfile and configuration.

## Architecture

| Area | Location | Purpose |
|---|---|---|
| Main UI | `app/components/CoachApp.tsx` | Application shell and product sections |
| Live squad builder | `app/components/LiveDraftBuilder.tsx` | Squad creation, saving/import, optimizer, pitch, captaincy |
| Intelligence UI | `app/components/LiveIntelligence.tsx` | Players, fixtures, news, chips, model, and history views |
| Official FPL data API | `app/api/fpl/route.ts` | Current players, teams, prices, stats, rules, events, fixtures |
| Team import API | `app/api/fpl/team/route.ts` | Imports a public squad by FPL Team ID |
| Manager history API | `app/api/fpl/history/route.ts` | Completed-gameweek points, ranks, transfers, bench and captain history |
| Projection model | `app/lib/fpl.ts` | Typed FPL data model, projections, best XI, and baseline optimization |
| Optimizer | `app/lib/optimizer.ts` | Multi-gameweek squad optimizer, risk modes, evaluation, and explanations |
| Transfer route solver | `app/lib/transfer-routes.ts` | Legal 3/5/8-GW roll, single and double-transfer route search with bank, selling values and hits |
| Database | `db/`, `drizzle.config.ts` | Drizzle/D1: users, sessions, squad_data |
| Auth | `app/lib/auth-core.ts`, `app/lib/auth.ts`, `app/api/auth/*` | Email/password + ChatGPT sign-in, unified by email identity |
| Worker | `worker/index.ts` | Cloudflare Worker request and image-optimization entry point |
| Hosting config | `.openai/hosting.json`, `vite.config.ts` | Sites identity and Cloudflare/Vinext bindings |

## Data sources and persistence

The server routes fetch the public official Fantasy Premier League API under `https://fantasy.premierleague.com/api`. No FPL API key is required. Responses are cached for five minutes where appropriate, while the client requests fresh application data without using demo rosters.

Current-season totals are rebuilt from official, finished and data-checked gameweeks; the active gameweek is kept separate for live scoring. The projection prior is the checked-in `app/data/prior-season-2025-26.json` snapshot generated from each current player's official `history_past` record. Players without a genuine 2025/26 Premier League record—including promoted-club players—use a conservative position baseline instead of another competition's stats.

The app persists locally to browser `localStorage` first, and syncs to D1 in the background when signed in (`app/lib/persistence.ts`) -- localStorage stays the source of truth every component reads; the server copy exists for cross-device access and to survive a cleared browser. Public FPL Team IDs are imported server-side using the official entry and picks endpoints.

Pressing **Lock This Team** before a deadline creates a versioned projection receipt inside the saved lock: the selected squad, XI, ordered bench, captaincy, all official players' five-event xPts path plus expected-minutes/confidence inputs, ranked single-transfer evidence, and the four strongest complete five-gameweek transfer routes. Version-7 receipts preserve every route's gameweek-by-gameweek moves, exact selling/buying prices, bank, free transfers, projected points and hit costs. Player rows use the documented compact `tuple-v4` encoding in `CoachApp.tsx`; it freezes team, position, prior-evidence group, and low-PL-continuity club context for historically correct calibration while older receipt schemas remain readable. The compact encoding keeps a full 38-gameweek archive practical in browser storage; signed-in accounts sync the same receipts through the existing D1-backed `locks` field.

After FPL marks an event finished, the History page automatically derives a model audit from the frozen receipt and official picks/live endpoints. It grades the team total only when the submitted squad, XI and captaincy match the receipt; otherwise it flags the plan divergence. Player-event xPts MAE, minutes MAE, start-probability Brier score, captain outcome, bias, within-two-points rate, and progressive ranked-transfer outcomes are recalculated on refresh from immutable official results rather than stored as fabricated history.

The History accuracy dashboard aggregates strictly one-gameweek-ahead player calibration, with exact breakdowns by gameweek, frozen position, frozen club, and prediction confidence (`High ≥ 0.75`, `Medium ≥ 0.50`, otherwise `Low`). Receipts are grouped by their immutable `modelVersion`; headline accuracy, History KPIs, captain error and transfer-route outcomes never pool different model generations. Users can switch between version cohorts and compare their separately calculated samples, while samples below five evaluated gameweeks remain labelled as early evidence. The release registry and human-readable change history live in `app/lib/model-version.ts` and are exposed on the Points Model page.

Player projections use four explicit Premier League evidence classes: established prior (`≥900` prior PL minutes), limited prior (`1–899`), no genuine PL prior, and established in the current PL season (`≥900` current minutes without an established prior). Limited/no-prior players receive stronger rate shrinkage, slower early-season learning, and lower confidence ceilings. Club context uses a roster-level PL-continuity score derived only from genuine prior PL minutes; low-continuity clubs receive an additional confidence reduction without hardcoding club names or substituting lower-division statistics. The Points Model exposes the assigned class and the History dashboard measures accuracy by that frozen class.

The separate team-quality model (`app/lib/team-quality.ts`) normalizes the official FPL attack/defence strength fields against the current 20-club league instead of treating their raw values as 1–5 FDR ratings. It maintains home/away attack and defence ratings, gradually blends in completed Premier League goals and official player xG, and confidence-damps every rating toward league average. Low-PL-continuity clubs receive conservative priors and slower authority, so one promoted-club result cannot dominate projections. These multipliers feed player xG/xA, clean-sheet probability, transfer rankings, the Fixtures ticker, and the Points Model transparency panel.

Transfer candidates pass through a shared quality gate before ranking. The gate classifies each legal single move as **Actionable**, **Watchlist**, or **Blocked** using expected minutes, start probability, confidence, Premier League evidence, club continuity, hard anomaly checks, and whether the five-gameweek gain survives removing its single best week. Only Actionable rows can become the headline single-move recommendation. Watchlist and Blocked rows remain visible for audit, but optimizer utility cannot promote them across the gate.

The route planner then searches complete 3, 5 or 8-gameweek strategies. Each state carries the legal 15-player squad, exact connected-manager selling values, bank and 0–5 free transfers into the next deadline. It evaluates rolling, one-transfer and two-transfer actions, charges the official four-point cost for transfers beyond the available allowance, and ranks complete plans by net projected points after hits. Incoming route anchors must clear the hard expected-minutes, start-probability and model-confidence floors, so a speculative player cannot become the foundation of an otherwise attractive sequence.

Bench order is optimized separately from starting-XI selection. The engine evaluates every permutation of the three outfield substitutes across all modeled appearance combinations, applies legal FPL formation floors (3 DEF, 2 MID, 1 FWD), and treats the reserve goalkeeper through the separate goalkeeper substitution rule. The Final Check page explains the chosen order, its expected autosub contribution and whether it improves on simple xPts sorting.

D1 is active (`.openai/hosting.json` has `"d1": "DB"`). For local dev, `@cloudflare/vite-plugin` auto-provisions a local D1 sqlite file the first time `npm run dev` runs, but does **not** auto-apply migrations to it. After a fresh `npm run dev` start (or whenever `drizzle/*.sql` changes), apply the migration once:

```bash
find .wrangler/state/v3/d1/miniflare-D1DatabaseObject -name "*.sqlite" ! -name "metadata.sqlite" -exec sqlite3 {} \; < drizzle/0000_nosy_gateway.sql
```

(Re-run `npm run db:generate` first if the schema changed, and apply the newly generated file instead.)

## Requirements

- Node.js `22.13.0` or newer
- npm (the lockfile was generated for npm-based installation)
- Linux or WSL for the repository's bounded helper scripts
- `bash`, `curl`, `flock`, GNU `timeout`, and `sha256sum` when using `npm run install:ci`

## Local setup

```bash
unzip FPL-Edge-complete-source-v15.zip
cd FPL-Edge-complete-source-v15
npm ci
npm run dev
```

Open the local URL printed by Vite. The development server binds to `0.0.0.0`.

For the repository's guarded Sites installation workflow on Linux/WSL, use:

```bash
npm run install:ci
npm run dev
```

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start the Vite/Vinext development server |
| `npm run build` | Run the bounded production Vinext build |
| `npm run start` | Start the built app locally |
| `npm test` | Build, then run rendered HTML and every TSX test |
| `npm run data:prior` | Refresh the official 2025/26 Premier League prior snapshot |
| `npm run lint` | Run ESLint while excluding generated output |
| `npm run db:generate` | Generate Drizzle migrations from `db/schema.ts` |
| `npm run install:ci` | Run the guarded, integrity-checked dependency install |

## Environment variables

No application secrets or required `.env` values are needed for the current FPL feature set.

| Variable | Required | Default / use |
|---|---:|---|
| `SITES_RUNTIME_ROOT` | No | Overrides the project-local `.sites-runtime` directory used by helper scripts |
| `SITES_INSTALL_TIMEOUT` | No | Dependency-install timeout; default `8m` |
| `SITES_INSTALL_KILL_AFTER` | No | Grace period after install termination; default `15s` |
| `SITES_BUILD_TIMEOUT` | No | Production-build timeout; default `3m` |
| `SITES_BUILD_KILL_AFTER` | No | Grace period after build termination; default `10s` |
| `SITES_NPM_CACHE_SEED` | No | Optional pre-seeded npm cache accepted only when its lockfile hash matches |
| `CODEX_SANDBOX` | No | Setting `seatbelt` enables polling-based file watching for that sandbox |
| `WRANGLER_WRITE_LOGS` | No | Wrangler logging control; the project defaults it to `false` |
| `WRANGLER_LOG_PATH` | No | Wrangler log directory; scripts use `.sites-runtime/wrangler/logs` |
| `MINIFLARE_REGISTRY_PATH` | No | Miniflare registry path; scripts keep it inside `.sites-runtime` |

The deployment environment supplies the `ASSETS` and `IMAGES` Cloudflare bindings. If D1 is enabled later, set the `d1` field in `.openai/hosting.json` to the binding name (the existing database helper expects `DB`) and provision that binding in the hosting environment.

The optional ChatGPT request identity integration reads these HTTP headers when they are injected by the hosting dispatch layer; they are headers, not environment variables:

- `oai-authenticated-user-email`
- `oai-authenticated-user-full-name`
- `oai-authenticated-user-full-name-encoding`

## Production build and deployment

Verify a production artifact locally:

```bash
npm ci
npm run build
npm run start
```

The current production site is deployed through OpenAI Sites, not through a standalone deploy script in `package.json`. To continue that deployment, open this source in a Sites-enabled workspace, keep `.openai/hosting.json` intact so the existing project identity is preserved, run the normal Sites preview/checkpoint flow, and verify the checkpoint before promoting it. The portable production validation command is `npm run build`; platform credentials and injected Cloudflare bindings belong in the deployment environment and are intentionally not stored in this archive.

If you move the app to another Cloudflare account or hosting system, provision equivalent `ASSETS` and `IMAGES` bindings and add `DB` only if you activate the optional D1 layer.

## Important implementation notes

- The official FPL API is contacted from server routes to avoid exposing a separate data credential.
- Manager squad/history import works only for data the official FPL API makes public; before the first deadline, the current squad may not yet be available.
- The optimizer and projections are application models, not an official FPL forecast.
- Re-run `npm run data:prior` if the official current-season player list changes materially; commit the regenerated snapshot with the source change.
- Keep `package-lock.json` committed and use `npm ci` for deterministic dependency installation.
- Do not commit local `.env*` files, Wrangler state, or runtime caches.

## Source preservation

All files from the source commit are present. The only documentation addition is this project README; the commit's original `README.md` is included byte-for-byte as `README.SITES.md`.
