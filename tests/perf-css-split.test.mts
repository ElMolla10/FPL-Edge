// Guards for the per-route / per-panel stylesheet split (docs/PERF-CSS.md).
//   * every sheet is imported by exactly the modules that should load it (so a route links only its own CSS),
//   * globals.css stays a small base sheet (no marketing / desk rules creep back in),
//   * for every route / lazy chunk, every rule whose classes that unit can render lives in a sheet that loads with it
//     (static analysis in scripts/css-usage.mjs; conservative for template-built class names such as fdr-${n}),
//   * the three data-built classes from audit B (.robust, .close-call, .high-risk) are defined in a sheet the desk loads.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import postcss from "postcss";
import { analyze, classesIn, UNIT_ENTRIES } from "../scripts/css-usage.mjs";
import { readAllCss } from "./helpers/all-css.mts";

const appDir = new URL("../app/", import.meta.url).pathname;
const src = (p: string) => readFileSync(join(appDir, p), "utf8");
const sheets = ["globals.css", ...readdirSync(join(appDir, "styles")).filter((f) => f.endsWith(".css")).sort().map((f) => `styles/${f}`)];
const sheetName = (p: string) => (p === "globals.css" ? "base" : p.replace(/^styles\//, "").replace(/\.css$/, ""));

test("each route imports only its own sheets (client modules, so vinext links them in render order)", () => {
  assert.doesNotMatch(src("layout.tsx"), /\.css["']/, "layout.tsx must not import CSS: a server-module CSS import is linked on every route, after the client sheets");
  const importsOf = (p: string) => [...src(p).matchAll(/^import "([^"]+\.css)";$/gm)].map((m) => m[1].replace(/^(\.\.?\/)+/, ""));
  assert.deepEqual(importsOf("page.tsx"), ["globals.css", "styles/paper.css", "styles/landing.css"]);
  for (const p of ["signin/page.tsx", "signup/page.tsx", "pay/page.tsx", "error.tsx"]) assert.deepEqual(importsOf(p), ["globals.css", "styles/paper.css"], p);
  // server components cannot import the sheets themselves (vinext emits a second, mis-ordered copy): they render the client wrapper
  const paperStyles = src("components/PaperStyles.tsx");
  assert.match(paperStyles, /^"use client";/m);
  assert.deepEqual(importsOf("components/PaperStyles.tsx"), ["globals.css", "styles/paper.css"]);
  for (const p of ["not-found.tsx", "components/RouteLoading.tsx"]) { assert.deepEqual(importsOf(p), [], p); assert.match(src(p), /<PaperStyles \/>/, p); }
  assert.deepEqual(importsOf("components/CoachApp.tsx"), ["styles/desk.css"]);
  const panelSheets: Record<string, string> = {
    "components/coach/TeamPanel.tsx": "panel-team", "components/coach/TransfersPanel.tsx": "panel-transfers", "components/coach/PlayersPanel.tsx": "panel-players",
    "components/coach/FinalCheckPanel.tsx": "panel-final", "components/coach/PlanPanels.tsx": "panel-plan", "components/coach/ResearchPanels.tsx": "panel-research",
    "components/LiveDraftBuilder.tsx": "panel-draft", "components/MiniLeagueWarRoom.tsx": "panel-league",
  };
  for (const [file, sheet] of Object.entries(panelSheets)) assert.deepEqual(importsOf(file), [`styles/${sheet}.css`], file);
  assert.deepEqual(importsOf("components/coach/CoachPanel.tsx"), [], "CoachPanel only needs the desk + shared panel sheets");
  // the shared panel sheet is requested before every panel chunk, so its <link> precedes the panel's own sheet
  const shell = src("components/CoachApp.tsx");
  assert.match(shell, /const loadPanelCss=\(\)=>import\("\.\.\/styles\/panel-common\.css"\)/);
  for (const loader of ["Team", "Transfers", "Players", "Coach", "Final", "Plan", "Research", "Draft", "League"]) assert.match(shell, new RegExp(`const load${loader}=withPanelCss\\(`), `load${loader} must go through withPanelCss`);
  // every sheet is imported by something
  const all = readAllSources(appDir).join("\n");
  for (const s of sheets) assert.ok(all.includes(s.replace(/^globals\.css$/, "globals.css")), `${s} is not imported anywhere`);
});

test("globals.css is only the base sheet (tokens, themes, resets)", () => {
  const base = src("globals.css");
  assert.ok(base.length < 12_000, `globals.css grew to ${base.length} bytes; route/panel rules belong in app/styles/`);
  assert.match(base, /^@import "tailwindcss";/);
  const used = classesIn(base.replace(/\/\*[\s\S]*?\*\//g, ""));
  assert.ok(used.length < 25, "class selectors in globals.css should be limited to shared base rules");
  assert.doesNotMatch(base, /\.paper-|\.coach-shell|\.builder-/);
});

test("every rule a route / lazy chunk can render is in a sheet that loads with it", () => {
  const all = readAllCss();
  const A = analyze(appDir.replace(/\/$/, ""), [all]);
  const entries = UNIT_ENTRIES(appDir.replace(/\/$/, ""));
  const unitUse: Record<string, Set<string>> = {};
  for (const [u, files] of Object.entries(entries)) unitUse[u] = A.unitClasses(files as string[]).used;
  const panels = ["team", "transfers", "players", "coach", "final", "plan", "research", "draft", "league"];
  for (const p of panels) unitUse[p] = new Set([...unitUse[p], ...unitUse.shell]); // a panel renders inside the shell
  const loaded: Record<string, string[]> = {
    landing: ["base", "paper", "landing"], auth: ["base", "paper"], pay: ["base", "paper"], misc: ["base", "paper"], shell: ["base", "desk"],
    ...Object.fromEntries(panels.map((p) => [p, ["base", "desk", "panel-common", `panel-${p}`]])),
  };
  const where = new Map<string, Set<string>>(); // rule key -> sheets that contain it
  const rules: { key: string; selectors: string[] }[] = [];
  for (const file of sheets) {
    postcss.parse(readFileSync(join(appDir, file), "utf8")).walkRules((rule) => {
      if (rule.parent?.type === "atrule" && /keyframes$/.test((rule.parent as postcss.AtRule).name)) return;
      const ctx: string[] = []; let p: postcss.Container | postcss.Document | undefined = rule.parent; while (p && p.type !== "root") { ctx.unshift(`${(p as postcss.AtRule).name} ${(p as postcss.AtRule).params}`); p = p.parent; }
      const key = `${ctx.join(">")}|${rule.selector}|${rule.nodes.map((n) => n.toString()).join(";")}`;
      if (!where.has(key)) { where.set(key, new Set()); rules.push({ key, selectors: rule.selectors }); }
      where.get(key)!.add(sheetName(file));
    });
  }
  const problems: string[] = [];
  for (const { key, selectors } of rules) {
    const sheetsHere = where.get(key)!;
    const parsed = selectors.map((s) => (/\[class[*^$~|]?=/.test(s) ? null : classesIn(s)));
    if (parsed.some((x) => x === null) || parsed.every((x) => x!.length === 0)) { if (!sheetsHere.has("base")) problems.push(`global rule outside base: ${key.slice(0, 90)}`); continue; }
    for (const [u, set] of Object.entries(unitUse)) {
      if (!parsed.some((cs) => cs!.length && cs!.every((c) => set.has(c)))) continue;
      if (!loaded[u].some((s) => sheetsHere.has(s))) problems.push(`${u}: ${key.slice(0, 100)} is only in [${[...sheetsHere]}]`);
    }
  }
  assert.deepEqual(problems.slice(0, 10), [], `${problems.length} rule(s) not reachable from the unit that renders them`);
});

test("classes built from data stay reachable from the desk (extends audit-b-css)", () => {
  const css = readAllCss();
  for (const cls of [".robust", ".close-call", ".high-risk"]) assert.ok(css.includes(cls), cls);
  // DecisionConfidencePanel is rendered by panels (Team / Transfers / Coach), all of which load desk.css or panel-common.css
  const desk = src("styles/desk.css") + src("styles/panel-common.css");
  for (const cls of [".robust", ".close-call", ".high-risk"]) assert.ok(desk.includes(cls), `${cls} must live in the desk or shared panel sheet`);
});

function readAllSources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) readAllSources(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(readFileSync(p, "utf8"));
  }
  return out;
}
