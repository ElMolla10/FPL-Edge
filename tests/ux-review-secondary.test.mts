import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { readAllCss } from "./helpers/all-css.mts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("titles: homepage and 404 are descriptive; signin/signup/pay stay distinct", async () => {
  // layout.tsx imports globals.css (not loadable under node), so read the root title from source.
  const layout = read("app/layout.tsx");
  const home = /const HOME_TITLE = "([^"]+)"/.exec(layout)?.[1] ?? "";
  assert.notEqual(home, "FPL Edge");
  assert.match(home, /FPL Edge/);
  assert.ok(home.length > "FPL Edge".length + 10, "homepage title says what the product does");
  assert.match(layout, /title: \{ default: HOME_TITLE, template: "%s" \}/, "template is a pass-through so child titles stay verbatim");
  const nf = (await import("../app/not-found.tsx")).metadata;
  assert.match(String(nf.title), /not found/i);
  const title = (m: { title?: unknown }) => String(m.title);
  const others = [(await import("../app/signin/layout.tsx")).metadata, (await import("../app/signup/layout.tsx")).metadata, (await import("../app/pay/layout.tsx")).metadata].map(title);
  assert.equal(new Set([home, title(nf), ...others]).size, 5, "all five titles are distinct");
});

test("sign-in: accessible show-password toggle, no forgot-password", () => {
  const src = read("app/components/AuthForm.tsx");
  assert.match(src, /type=\{showPassword \? "text" : "password"\}/);
  assert.match(src, /aria-pressed=\{showPassword\}/);
  assert.match(src, /aria-label="Show password"/);
  assert.match(src, /aria-controls="auth-password"/);
  assert.match(src, /htmlFor="auth-password"/);
  assert.match(src, /type="button" className="paper-password-toggle"/, "toggle must not submit the form");
  assert.doesNotMatch(src, /forgot|reset/i);
  // Auth request shape is unchanged (#80: session cookie only).
  assert.match(src, /\/api\/auth\/login/);
  assert.match(src, /JSON\.stringify\(\{ email, password \}\)/);
});

test("coach questions are grouped by topic and cover all nine intents exactly once", () => {
  const src = read("app/components/coach/CoachPanel.tsx");
  const groups = src.slice(src.indexOf("const COACH_INTENT_GROUPS"), src.indexOf("const intentLabel"));
  const ids = [...groups.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]).filter((id) => id !== "");
  const intents = ["captain", "transfer-best", "transfer-for", "price", "chip", "differentials", "live", "rank", "build"];
  assert.deepEqual([...ids.filter((id) => intents.includes(id))].sort(), [...intents].sort());
  assert.equal(new Set(ids.filter((id) => intents.includes(id))).size, 9);
  assert.match(src, /aria-pressed=\{intent===id\}/);
});

test("sidebar Research/PRO: expanded state, navigation to the first item, group stays open; PRO/lock rules intact", () => {
  const src = read("app/components/CoachApp.tsx");
  assert.match(src, /aria-expanded=\{sidebarMenu==="research"\}/);
  assert.match(src, /aria-expanded=\{sidebarMenu==="pro"\}/);
  assert.match(src, /toggleSidebarGroup\("research",researchRest\)/);
  assert.match(src, /toggleSidebarGroup\("pro",proItems\)/);
  assert.match(src, /go\(items\[0\]\[0\]\)/);
  // navigating inside a group keeps it open; leaving it closes it
  assert.match(src, /setSidebarMenu\(sidebarGroupFor\(next\)\)/);
  assert.doesNotMatch(src, /setSidebarMenu\(null\);window\.scrollTo/);
  // memory preferences: PRO dropdown directly under the other sidebar items, caret on both, lock on PRO items
  const side = src.slice(src.indexOf('<aside className="coach-sidebar">'), src.indexOf("</aside>"));
  assert.ok(side.indexOf("coach-primary") < side.indexOf("sidebar-menus") && side.indexOf("sidebar-menus") < side.indexOf('className="sidebar-pro"'));
  assert.equal((side.match(/className="nav-caret"/g) ?? []).length, 2);
  assert.match(side, /desk!=="season"&&<NavLock\/>/);
  assert.match(src, /const PRO_VIEWS: ReadonlySet<View> = new Set\(\["news", "draft", "board", "chips", "history"\]\)/);
});

test("homepage footer has breathing room; phone Overview is tighter without touching the shared ranking", () => {
  const css = readAllCss();
  assert.match(css, /\.paper-footer\{margin-top:72px;padding-top:24px;border-top:1px solid var\(--hairline\)/);
  assert.match(css, /\.urgent-card>div>article:nth-child\(n\+4\)\{display:none\}/);
  const overview = read("app/components/CoachApp.tsx");
  assert.match(overview, /mode:"shallow"/);
  assert.match(overview, /rankTransfersForBestDecision\(/);
});
