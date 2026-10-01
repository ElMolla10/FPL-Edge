// Every asset the built worker's HTML points at (and every chunk reference inside the built client graph) must exist in dist/client.
// Guards against "phantom" chunks: Vite drops a pure-CSS JS chunk from the bundle *after* the RSC plugin has already written its URL
// into the assets manifest, so every page then emits <link rel="modulepreload"> for a file that 404s. Runs after `npm run build`.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const clientDir = new URL("../dist/client/", import.meta.url);
const assetsDir = new URL("assets/", clientDir);
const exists = (urlPath) => existsSync(new URL(decodeURIComponent(urlPath.replace(/^\/+/, "")), clientDir));

const { default: worker } = await (async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `refs-${process.pid}-${Date.now()}`);
  return import(workerUrl.href);
})();

async function render(path) {
  const response = await worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  return { status: response.status, html: await response.text() };
}

function localRefs(html) {
  const refs = [];
  for (const tag of html.match(/<(?:link|script)\b[^>]*>/gi) ?? []) {
    const rel = /\brel=["']([^"']+)["']/i.exec(tag)?.[1] ?? (/^<script/i.test(tag) ? "script" : "link");
    const url = /\b(?:href|src)=["']([^"']+)["']/i.exec(tag)?.[1];
    if (url?.startsWith("/") && !url.startsWith("//")) refs.push({ rel, url: url.split(/[?#]/)[0] });
  }
  return refs;
}

const ROUTES = [
  ["/", 200], ["/signin", 200], ["/signup", 200], ["/pay", 200], ["/?demo=1", 200], ["/?app=1", 200], ["/definitely-not-a-route", 404],
];

for (const [path, status] of ROUTES) {
  test(`rendered HTML of ${path}: every modulepreload / stylesheet / script / icon / asset URL exists in dist/client`, async () => {
    const page = await render(path);
    assert.equal(page.status, status);
    const refs = localRefs(page.html);
    assert.ok(refs.some((r) => r.rel === "stylesheet"), "page links a stylesheet");
    assert.ok(refs.some((r) => r.rel === "modulepreload"), "page preloads its entry chunk");
    const missing = refs.filter((r) => !exists(r.url)).map((r) => `${r.rel} ${r.url}`);
    assert.deepEqual(missing, [], `404 in built output: ${missing.join(", ")}`);
    // anything else the document mentions under /assets/ (inline bootstrap import(), RSC payload chunk lists, font preloads)
    const mentioned = new Set(page.html.match(/\/assets\/[A-Za-z0-9_./%-]+\.(?:js|css|woff2?|png|svg)/g) ?? []);
    const missingMentioned = [...mentioned].filter((u) => !exists(u));
    assert.deepEqual(missingMentioned, [], `HTML mentions missing assets: ${missingMentioned.join(", ")}`);
  });
}

test("assets manifest (clientReferenceDeps) only names files that were emitted", async () => {
  const manifestUrl = new URL("../dist/server/__vite_rsc_assets_manifest.js", import.meta.url);
  const { default: manifest } = await import(manifestUrl.href);
  const missing = [];
  for (const [key, deps] of Object.entries(manifest.clientReferenceDeps)) {
    for (const file of [...deps.js, ...deps.css]) if (!exists(file)) missing.push(`${key}: ${file}`);
  }
  for (const [key, deps] of Object.entries(manifest.serverResources ?? {})) {
    for (const file of [...(deps.js ?? []), ...(deps.css ?? [])]) if (!exists(file)) missing.push(`${key}: ${file}`);
  }
  assert.match(manifest.bootstrapScriptContent, /\/assets\/index-/);
  assert.deepEqual(missing, [], `manifest lists files that do not exist: ${missing.join(", ")}`);
});

test("client chunk graph: static/dynamic imports and Vite's preload maps (lazy panels + their stylesheets) resolve to emitted files", () => {
  const manifest = JSON.parse(readFileSync(new URL(".vite/manifest.json", clientDir), "utf8"));
  const missing = [];
  for (const [key, entry] of Object.entries(manifest)) {
    for (const f of [entry.file, ...(entry.css ?? []), ...(entry.assets ?? [])]) if (f && !exists(f)) missing.push(`manifest ${key}: ${f}`);
    for (const k of [...(entry.imports ?? []), ...(entry.dynamicImports ?? [])]) if (!(k in manifest)) missing.push(`manifest ${key}: unknown import ${k}`);
  }
  const jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
  assert.ok(jsFiles.length > 20);
  for (const file of jsFiles) {
    const code = readFileSync(new URL(file, assetsDir), "utf8");
    // `from"./x.js"`, `import("./x.js")`, `import"./x.js"` between chunks
    for (const m of code.matchAll(/(?:from|import\()?\s*["'](\.\/[^"']+\.(?:js|css))["']/g)) if (!existsSync(new URL(m[1].slice(2), assetsDir))) missing.push(`${file}: ${m[1]}`);
    // Vite's `__vite__mapDeps` table behind every dynamic import() (this is the lazyView/withPanelCss prefetch list)
    const map = /__vite__mapDeps=\(i,m=__vite__mapDeps,d=\(m\.f\|\|\(m\.f=\[([^\]]*)\]\)\)\)/.exec(code);
    for (const m of map?.[1].matchAll(/"([^"]+)"/g) ?? []) if (!exists(m[1])) missing.push(`${file}: preload map ${m[1]}`);
  }
  assert.deepEqual(missing, [], `dangling chunk references: ${missing.join("; ")}`);
});
