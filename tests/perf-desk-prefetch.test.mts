// Decision-desk code-splitting + prefetch wiring (source-level guards; behaviour is verified in Chrome, see docs/PERF-CSS.md).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const shell = read("app/components/CoachApp.tsx");

test("ReconnectFplPanel and SeasonLocked are not part of the eager desk bundle", () => {
  assert.doesNotMatch(shell, /^import ReconnectFplPanel/m);
  assert.match(shell, /const LazyReconnectFpl=lazy\(\(\)=>import\("\.\/ReconnectFplPanel"\)\)/);
  assert.match(shell, /<Suspense fallback=\{null\}><LazyReconnectFpl /);
  assert.doesNotMatch(read("app/components/SeasonPass.tsx"), /SeasonLocked/, "SeasonPass.tsx is the /pay checkout form only");
  assert.match(shell, /from "\.\/SeasonLocked"/);
  assert.doesNotMatch(read("app/pay/page.tsx"), /SeasonLocked/);
});

test("every desk panel stays behind a dynamic import", () => {
  for (const f of ["TeamPanel", "TransfersPanel", "PlayersPanel", "CoachPanel", "FinalCheckPanel", "PlanPanels", "ResearchPanels"]) {
    assert.match(shell, new RegExp(`import\\("\\./coach/${f}"\\)`));
    assert.doesNotMatch(shell, new RegExp(`^import .* from "\\./coach/${f}"`, "m"));
  }
  for (const f of ["LiveDraftBuilder", "MiniLeagueWarRoom"]) {
    assert.match(shell, new RegExp(`import\\("\\./${f}"\\)`));
    assert.doesNotMatch(shell, new RegExp(`^import .* from "\\./${f}"`, "m"));
  }
});

test("nav items prefetch their chunk on hover, focus and touchstart; idle warms the rest", () => {
  assert.match(shell, /const warm=\(view:View\)=>\(\{onPointerEnter:\(\)=>preloadView\(view\),onFocus:\(\)=>preloadView\(view\),onTouchStart:\(\)=>preloadView\(view\)\}\)/);
  // sidebar primary + Research/PRO dropdown rows + the two group toggles, phone tabs (Squad, PRO, Coach) and sheet rows
  assert.ok((shell.match(/\{\.\.\.warm\(/g) ?? []).length >= 14);
  assert.match(shell, /toggleSidebarGroup\("research",researchRest\)\} \{\.\.\.warm\(researchRest\[0\]\[0\]\)\}/);
  assert.match(shell, /toggleSidebarGroup\("pro",proItems\)\} \{\.\.\.warm\(proItems\[0\]\[0\]\)\}/);
  assert.match(shell, /PREFETCH_AFTER_PAINT:readonly View\[\]=\["team","transfers","players","coach","deadline"\]/);
  assert.match(shell, /PREFETCH_SECONDARY:readonly View\[\]=\["ownership","board","league","draft"\]/);
  assert.match(shell, /connectionAllowsIdlePrefetch\(\)/);
  assert.match(shell, /saveData/);
});

test("a prefetched view mounts without suspending (no Loading flash); an un-prefetched one still shows the placeholder", () => {
  assert.match(shell, /function lazyView<M,P extends object>\(load:\(\)=>Promise<M>,pick:\(m:M\)=>ComponentType<P>\)/);
  assert.match(shell, /const \[Chosen\]=useState<ComponentType<P>>\(\(\)=>ready\?\?Lazy\)/);
  // every desk view goes through lazyView and preloadView warms the same instances
  assert.equal((shell.match(/=lazyView\(load/g) ?? []).length, 16);
  assert.match(shell, /lazyByView\[view\]\?\.warm\(\)/);
  assert.match(shell, /<Suspense fallback=\{<PanelFallback\/>\}><PageContent/);
});
