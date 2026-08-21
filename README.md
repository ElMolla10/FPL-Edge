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
| Database | `db/`, `drizzle.config.ts` | Drizzle/D1: users, sessions, squad_data |
| Auth | `app/lib/auth-core.ts`, `app/lib/auth.ts`, `app/api/auth/*` | Email/password + ChatGPT sign-in, unified by email identity |
| Worker | `worker/index.ts` | Cloudflare Worker request and image-optimization entry point |
| Hosting config | `.openai/hosting.json`, `vite.config.ts` | Sites identity and Cloudflare/Vinext bindings |

## Data sources and persistence

The server routes fetch the public official Fantasy Premier League API under `https://fantasy.premierleague.com/api`. No FPL API key is required. Responses are cached for five minutes where appropriate, while the client requests fresh application data without using demo rosters.

The app persists locally to browser `localStorage` first, and syncs to D1 in the background when signed in (`app/lib/persistence.ts`) -- localStorage stays the source of truth every component reads; the server copy exists for cross-device access and to survive a cleared browser. Public FPL Team IDs are imported server-side using the official entry and picks endpoints.

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
| `npm test` | Build, then run the rendered HTML test suite |
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
- Keep `package-lock.json` committed and use `npm ci` for deterministic dependency installation.
- Do not commit local `.env*` files, Wrangler state, or runtime caches.

## Source preservation

All files from the source commit are present. The only documentation addition is this project README; the commit's original `README.md` is included byte-for-byte as `README.SITES.md`.
