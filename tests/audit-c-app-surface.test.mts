import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

// ---------- 13: robots / sitemap / metadata ----------

test("site url: default is the live host, env override is normalised, junk falls back", async () => {
  const { normalizeSiteUrl, PUBLIC_PATHS } = await import("../app/lib/site.ts");
  assert.equal(normalizeSiteUrl(undefined), "https://fpl-edge.elmolla10.workers.dev");
  assert.equal(normalizeSiteUrl(""), "https://fpl-edge.elmolla10.workers.dev");
  assert.equal(normalizeSiteUrl("not a url"), "https://fpl-edge.elmolla10.workers.dev");
  assert.equal(normalizeSiteUrl("https://example.com///"), "https://example.com");
  assert.deepEqual([...PUBLIC_PATHS], ["/", "/signin", "/signup", "/pay", "/privacy", "/terms"]);
});

test("robots: allows public pages, blocks /api/ and app-only surfaces, points at the sitemap", async () => {
  const { default: robots } = await import("../app/robots.ts");
  const { SITE_URL } = await import("../app/lib/site.ts");
  const r = robots();
  const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
  assert.equal(rules.length, 1);
  const rule = rules[0];
  assert.equal(rule.userAgent, "*");
  assert.equal(rule.allow, "/");
  const disallow = ([] as string[]).concat(rule.disallow ?? []);
  assert.ok(disallow.includes("/api/"));
  assert.ok(disallow.includes("/*?app="));
  assert.ok(disallow.includes("/*?demo="));
  assert.ok(!disallow.includes("/"), "must not disallow the whole site");
  assert.equal(r.sitemap, `${SITE_URL}/sitemap.xml`);
});

test("sitemap: lists exactly the public pages on the site url", async () => {
  const { default: sitemap } = await import("../app/sitemap.ts");
  const { SITE_URL } = await import("../app/lib/site.ts");
  const urls = sitemap().map((e) => e.url);
  assert.deepEqual(urls, [`${SITE_URL}/`, `${SITE_URL}/signin`, `${SITE_URL}/signup`, `${SITE_URL}/pay`, `${SITE_URL}/privacy`, `${SITE_URL}/terms`]);
  for (const u of urls) assert.ok(!u.includes("/api/") && !u.includes("?"));
});

test("per-route metadata: /signin, /signup, /pay each have their own title + description", async () => {
  const signin = (await import("../app/signin/layout.tsx")).metadata;
  const signup = (await import("../app/signup/layout.tsx")).metadata;
  const pay = (await import("../app/pay/layout.tsx")).metadata;
  const titles = [signin, signup, pay].map((m) => String(m.title));
  const descriptions = [signin, signup, pay].map((m) => String(m.description));
  assert.equal(new Set(titles).size, 3, "titles must be distinct");
  assert.equal(new Set(descriptions).size, 3, "descriptions must be distinct");
  for (const t of titles) assert.match(t, /FPL Edge/);
  assert.notEqual(titles[0], "FPL Edge");
});

// ---------- 14: error / not-found / loading ----------

test("error.tsx is a client component, wired to reset, and links home", async () => {
  const src = read("app/error.tsx");
  assert.match(src, /^(\/\*[\s\S]*?\*\/\s*)?"use client";/, "must start with the use client directive");
  assert.match(src, /onClick=\{\(\) => reset\(\)\}/);
  const { default: RouteError } = await import("../app/error.tsx");
  const html = renderToStaticMarkup(createElement(RouteError, { error: new Error("boom"), reset: () => {} }));
  assert.match(html, /The desk hit a snag\./);
  assert.match(html, /<button[^>]*>Try again<\/button>/);
  assert.match(html, /href="\/"/);
  assert.match(html, /brand-logo/);
  assert.doesNotMatch(html, /boom/, "must not leak the underlying error message to users");
});

test("not-found.tsx and loading.tsx render the branded shell with a home link", async () => {
  const { default: NotFound } = await import("../app/not-found.tsx");
  const nf = renderToStaticMarkup(createElement(NotFound));
  assert.match(nf, /This page is offside\./);
  assert.match(nf, /brand-logo/);
  assert.match(nf, /href="\/"[^>]*>Back to home/);

  const { RouteLoading } = await import("../app/components/RouteLoading.tsx");
  const ld = renderToStaticMarkup(createElement(RouteLoading));
  assert.match(ld, /brand-logo/);
  assert.match(ld, /aria-busy="true"/);
  assert.match(ld, /paper-loading-bar/);
  for (const seg of ["signin", "signup", "pay"]) {
    assert.match(read(`app/${seg}/loading.tsx`), /RouteLoading/);
  }
  // Root loading.tsx would stream the public homepage behind a Suspense fallback under vinext.
  assert.ok(!existsSync(path.join(root, "app/loading.tsx")));
});

test("built worker serves robots.txt, sitemap.xml and a branded 404 (requires npm run build)", async (t) => {
  const workerPath = path.join(root, "dist/server/index.js");
  if (!existsSync(workerPath)) return t.skip("dist not built");
  const url = new URL(`file://${workerPath}`);
  url.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(url.href);
  const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const get = (p: string) => worker.fetch(new Request(`http://localhost${p}`, { headers: { accept: "text/html" } }), env, ctx);

  const robots = await get("/robots.txt");
  assert.equal(robots.status, 200);
  const robotsText = await robots.text();
  assert.match(robotsText, /Disallow: \/api\//);
  assert.match(robotsText, /Sitemap: https?:\/\/[^\s]+\/sitemap\.xml/);

  const sitemap = await get("/sitemap.xml");
  assert.equal(sitemap.status, 200);
  assert.match(await sitemap.text(), /<loc>https?:\/\/[^<]+\/pay<\/loc>/);

  const missing = await get("/definitely-not-a-page");
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /This page is offside\./);

  for (const [p, title] of [["/signin", "Sign in — FPL Edge"], ["/signup", "Create an account — FPL Edge"], ["/pay", "Season pass — FPL Edge"]]) {
    const html = await (await get(p)).text();
    assert.ok(html.includes(`<title>${title}</title>`), `${p} title`);
  }
});

// ---------- 15: CI ----------

test("deploy workflow runs typecheck and lint before tests and deploy, on Node 22", () => {
  const wf = read(".github/workflows/deploy.yml");
  const idx = (needle: string) => {
    const i = wf.indexOf(needle);
    assert.ok(i >= 0, `workflow is missing: ${needle}`);
    return i;
  };
  const typecheck = idx("run: npm run typecheck");
  const lint = idx("run: npm run lint:ratchet");
  const tests = idx("run: npm test");
  const deploy = idx("run: npx vinext deploy");
  assert.ok(typecheck < tests && lint < tests && tests < deploy, "typecheck/lint must precede tests and deploy");
  assert.ok(idx("run: npm run install:ci") < typecheck);
  assert.match(wf, /node-version: "22\./);
  assert.doesNotMatch(wf, /continue-on-error/, "gates must actually block");
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts.typecheck, "tsc --noEmit");
  assert.equal(pkg.scripts["lint:ratchet"], "node scripts/lint-ratchet.mjs");
});

test("lint ratchet: only files above baseline are regressions; baseline file is valid", async () => {
  const { compareToBaseline } = await import("../scripts/lint-ratchet.mjs");
  const base = { "a.ts": 2, "b.ts": 1 };
  assert.deepEqual(compareToBaseline({ "a.ts": 2, "b.ts": 1 }, base), { regressions: [], improvements: [] });
  assert.deepEqual(compareToBaseline({ "a.ts": 1 }, base).improvements, [
    { file: "a.ts", allowed: 2, count: 1 },
    { file: "b.ts", allowed: 1, count: 0 },
  ]);
  assert.deepEqual(compareToBaseline({ "a.ts": 3, "b.ts": 1 }, base).regressions, [{ file: "a.ts", allowed: 2, count: 3 }]);
  assert.deepEqual(compareToBaseline({ "new.ts": 1 }, base).regressions, [{ file: "new.ts", allowed: 0, count: 1 }]);
  const baseline = JSON.parse(read(".github/lint-baseline.json"));
  for (const [file, n] of Object.entries(baseline)) {
    assert.ok(existsSync(path.join(root, file)), `baseline references a missing file: ${file}`);
    assert.ok(Number.isInteger(n) && (n as number) > 0);
  }
});

// ---------- 16 / 17 / 18: hygiene ----------

test("stray next.config is gone (vinext config is empty; vite.config.ts + wrangler.jsonc are authoritative)", () => {
  for (const f of ["next.config.ts", "next.config.js", "next.config.mjs", "next.config.cjs"]) {
    assert.ok(!existsSync(path.join(root, f)), `${f} should not exist`);
  }
});

test("root report markdown moved under docs/, README is the only root .md, README links resolve", () => {
  const rootMd = readdirSync(root).filter((f) => f.endsWith(".md"));
  assert.deepEqual(rootMd, ["README.md"]);
  const moved = [
    "HANDOFF.md",
    "OVERVIEW_HANG_HOTFIX.md",
    "PROJECTION_ENGINE_AUDIT.md",
    "PROJECTION_ENGINE_REPORT.md",
    "README.SITES.md",
    "SHELL_IA_REVIEW_PACKAGE.md",
    "TRANSFER_DECISION_REFINE_REPORT.md",
  ];
  const readme = read("README.md");
  for (const f of moved) {
    assert.ok(existsSync(path.join(root, "docs", f)), `docs/${f} missing`);
    assert.ok(readme.includes(`](docs/${f})`), `README does not link docs/${f}`);
  }
  const links = [...readme.matchAll(/\]\((docs\/[^)#\s]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length >= moved.length);
  for (const l of links) assert.ok(existsSync(path.join(root, l)), `broken README link: ${l}`);
  // No stale bare-root references to the moved files in README/code comments.
  for (const rel of ["README.md", "vite.config.ts", "app/lib/wildcard-tuning.ts"]) {
    for (const f of moved) {
      const stale = new RegExp(`(?<![\\w/.-])${f.replace(/\./g, "\\.")}`, "g");
      const body = read(rel).replace(new RegExp(`docs/${f.replace(/\./g, "\\.")}`, "g"), "");
      // Table link text like [`docs/X.md`](docs/X.md) is already stripped; anything left is stale.
      assert.doesNotMatch(body, stale, `${rel} still references root ${f}`);
    }
  }
});

test("SOURCE_SNAPSHOT.txt (generated Sites export header) is removed and ignored", () => {
  assert.ok(!existsSync(path.join(root, "SOURCE_SNAPSHOT.txt")));
  assert.match(read(".gitignore"), /^\/SOURCE_SNAPSHOT\.txt$/m);
});
