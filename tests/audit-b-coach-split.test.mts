import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { coachViewFromLocation, coachViewSearchParams, parseCoachView } from "../app/components/CoachApp.tsx";
import * as core from "../app/components/coach/CoachCore.tsx";
import { readCoachSource } from "./helpers/coach-source.mts";

const shell = readFileSync(new URL("../app/components/CoachApp.tsx", import.meta.url), "utf8");
const panelFiles = readdirSync(new URL("../app/components/coach/", import.meta.url)).filter((f) => f.endsWith(".tsx"));
const page = shell.slice(shell.indexOf("function PageContent"), shell.indexOf("function Page("));

const ALL_VIEWS = ["overview", "team", "transfers", "league", "draft", "board", "players", "ownership", "season-stats", "coach", "squad-fixtures", "fixtures", "news", "deadline", "chips", "model", "history"] as const;

test("the shell stays small and panels live in feature modules", () => {
  assert.ok(shell.length < 80_000, `CoachApp.tsx is ${shell.length} bytes`);
  for (const file of ["CoachCore", "TeamPanel", "TransfersPanel", "PlayersPanel", "CoachPanel", "FinalCheckPanel", "PlanPanels", "ResearchPanels"]) {
    assert.ok(panelFiles.includes(`${file}.tsx`), `${file}.tsx exists`);
  }
});

test("Overview is rendered statically (first paint never waits on a chunk)", () => {
  assert.match(page, /if\(view==="overview"\)return <Overview /);
  assert.doesNotMatch(shell, /lazy\([^)]*Overview/);
  assert.match(shell, /function Overview\(/);
});

test("every non-overview view is lazy and the shell has no static import of panel modules", () => {
  for (const view of ALL_VIEWS.filter((v) => v !== "overview" && v !== "history")) {
    assert.match(page, new RegExp(`view==="${view}"\\)return <Lazy`), `${view} renders a lazy panel`);
  }
  assert.match(page, /return <LazyHistoryView /); // fall-through view
  const staticImports = shell.split("\n").filter((line) => /^import\b/.test(line) && !/^import type\b/.test(line));
  for (const line of staticImports) {
    assert.doesNotMatch(line, /from "\.\/coach\/(?!CoachCore)/, `static panel import: ${line}`);
    assert.doesNotMatch(line, /LiveDraftBuilder|MiniLeagueWarRoom/, `static import: ${line}`);
  }
  assert.match(shell, /import\("\.\/LiveDraftBuilder"\)/);
  assert.match(shell, /import\("\.\/MiniLeagueWarRoom"\)/);
  assert.match(shell, /<Suspense fallback=\{<PanelFallback\/>\}>/);
});

test("?view= deep links start the chunk download before data arrives; navigation preloads too", () => {
  assert.match(shell, /useState<View>\(\(\)=>\{[^]*coachViewFromLocation\(window\.location\.search\)[^]*preloadView\(initial\)/);
  assert.match(shell, /const go=\(next:View\)=>\{preloadView\(next\)/);
  assert.match(shell, /popstate|preloadView\(next\);setView\(next\)/);
  assert.match(shell, /PREFETCH_AFTER_PAINT/);
  assert.match(shell, /scheduleDeferred\(\(\)=>\{for\(const v of PREFETCH_AFTER_PAINT\)preloadView\(v\)\}/);
});

test("URL view parsing and round-trips are unchanged", () => {
  for (const view of ALL_VIEWS) {
    assert.equal(parseCoachView(view), view);
    assert.equal(coachViewFromLocation(`?view=${view}`), view);
  }
  assert.equal(parseCoachView("nope"), null);
  assert.equal(parseCoachView(" TEAM "), "team");
  assert.equal(coachViewFromLocation("?app=1&view=transfers&x=1"), "transfers");
  assert.match(coachViewSearchParams("transfers", "?app=1"), /view=transfers/);
});

test("Overview and Transfers share one rankTransfersForBestDecision implementation", () => {
  assert.equal(typeof core.rankTransfersForBestDecision, "function");
  const all = readCoachSource();
  assert.equal((all.match(/function rankTransfersForBestDecision\(/g) ?? []).length, 1);
  // Both surfaces read the canonical weekly decision hook, which is the only caller of the ranking.
  const transfers = readFileSync(new URL("../app/components/coach/TransfersPanel.tsx", import.meta.url), "utf8");
  assert.match(shell, /import \{[^}]*useWeeklyDecision[^}]*\} from "\.\/coach\/CoachCore"/);
  assert.match(transfers, /import \{[^}]*useWeeklyDecision[^}]*\} from "\.\/CoachCore"/);
});

test("Draft Lab web worker is still created inside the lazily loaded LiveDraftBuilder (CSP worker-src 'self' blob:)", () => {
  const builder = readFileSync(new URL("../app/components/LiveDraftBuilder.tsx", import.meta.url), "utf8");
  assert.match(builder, /new Worker\(new URL\("\.\.\/workers\/draft-lab\.worker\.ts",import\.meta\.url\),\{type:"module"\}\)/);
  assert.doesNotMatch(shell, /new Worker\(/);
  const csp = readFileSync(new URL("../app/lib/security-headers.ts", import.meta.url), "utf8");
  assert.match(csp, /worker-src 'self' blob:/);
});

test("demo isolation: lazy panels receive the same data props and the shell still gates on desk state", () => {
  assert.match(page, /desk==="unknown"&&PRO_VIEWS\.has\(view\)/);
  assert.match(page, /desk==="free"&&view==="news"/);
  assert.match(shell, /isExampleSquadActive|exampleActive/);
});
