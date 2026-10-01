# Per-route / per-panel stylesheets and decision-desk code splitting

`app/globals.css` used to be one 239 KB (228 KB built, 38 KB gz) sheet linked on every route. It is now a small **base** sheet plus
sheets in `app/styles/`, each imported by the client module that needs it, so a route links only its own CSS.

| sheet | contents | loaded by |
|---|---|---|
| `app/globals.css` | `@import "tailwindcss"`, design tokens, light/dark themes, resets, rules shared by the marketing pages and the desk | every route (imported by each route's client module, see below) |
| `styles/paper.css` | `paper-*` marketing/auth/pay rules | `/`, `/signin`, `/signup`, `/pay`, 404, error, route loading |
| `styles/landing.css` | landing-only rules (`/`, incl. the `coach-loading` fallback) | `/` |
| `styles/desk.css` | decision-desk shell + everything several panels share | `CoachApp` chunk (`/?app=1`, `/?demo=1`) |
| `styles/panel-common.css` | rules shared by several *lazy* panels but not the shell | requested before any panel chunk (`withPanelCss` in `CoachApp.tsx`) |
| `styles/panel-{team,transfers,players,final,plan,research,draft,league}.css` | rules only that panel renders | that panel's chunk |

## Why client modules import the sheets (not `layout.tsx`)

vinext/RSC links CSS imported by a **server** module (e.g. `layout.tsx -> globals.css`) as an "importer resource" on *every* route, and
after the client-reference sheets. That would put the base sheet after `paper.css` and defeat the cascade the split was generated for.
CSS reached through a client module is linked in render order, so the base sheet comes first: every paper route (`page.tsx`, `signin/page.tsx`,
`signup`, `pay`, `error.tsx`) does `import "./components/PaperStyles"` (which imports `globals.css` then `styles/paper.css`), and `/` adds `landing.css` after it.
Server components (`not-found.tsx`, `RouteLoading`) render the client wrapper `components/PaperStyles.tsx`.

**Do not import `globals.css` + `paper.css` directly from several modules.** Rollup then hoists them into a shared chunk with no JS of its own; Vite
deletes such a pure-CSS chunk from the bundle, but the RSC assets manifest (and so every page's `<link rel="modulepreload">`) was already written
with its URL, and the preload 404s. Routing them through `PaperStyles` (a module with a real export) keeps a real chunk.
`tests/built-asset-refs.test.mjs` renders each route from the built worker and fails if any modulepreload/stylesheet/script URL, manifest entry or
`__vite__mapDeps` preload is missing from `dist/client`. The shared sheet is now emitted as `PaperStyles-<hash>.css` (byte-identical to the old `paper-<hash>.css`).

## Cascade

The generator assigned every rule to the files of the routes/panels that can render its classes (static analysis, `scripts/css-usage.mjs`),
kept source order inside each file, and for every pair of same-specificity rules that could hit one element (and set an overlapping
property) made sure the later rule loads after the earlier one in every route where both load - copying the later rule into the
earlier rule's sheet where needed (a small amount of intentional duplication). Load order: base < paper < landing < desk < panel-common < panel-*.
Lazy panels are treated as mutually unordered, so rules shared by two panels that could conflict are copied rather than relied on.

`tests/perf-css-split.test.mts` guards: which module imports which sheet, `globals.css` staying a base sheet, and - per route / lazy
chunk - that every rule whose classes that unit can render is present in a sheet that loads with it (conservative for `fdr-${n}`-style
template names and data-built `.robust` / `.close-call` / `.high-risk`). `scripts/audit-unused-css.mjs` audits all sheets (0 dead selectors).

## Adding CSS

Put a rule in the sheet of the (smallest) set of routes/panels that render it. If a class is used by the shell *and* a panel, it goes in
`desk.css`. If a new rule overrides an earlier same-specificity rule from another sheet, keep it in a sheet that loads *after* that one.
