import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import test from "node:test";
import { buildCsp, createCspNonce, nonceFromCsp, prepareSecurity } from "../app/lib/security-headers.ts";

const htmlResponse = () => new Response("<html></html>", { headers: { "content-type": "text/html; charset=utf-8" } });
const secureReq = new Request("https://fpl-edge.example.workers.dev/");

test("buildCsp: strict script-src (self + nonce only), no unsafe-inline/eval for scripts, no framing, no object/base abuse", () => {
  const csp = buildCsp("abc123");
  const script = csp.split("; ").find((d) => d.startsWith("script-src "))!;
  assert.equal(script, "script-src 'self' 'nonce-abc123'");
  assert.doesNotMatch(script, /unsafe-inline|unsafe-eval|\*|https?:/);
  for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'", "frame-src 'none'", "connect-src 'self'"]) {
    assert.ok(csp.split("; ").includes(d), d);
  }
  assert.match(csp, /upgrade-insecure-requests/);
  assert.doesNotMatch(buildCsp("n", { secure: false }), /upgrade-insecure-requests/);
});

test("nonce is 128-bit random, unique per call, and round-trips through nonceFromCsp", () => {
  const a = createCspNonce();
  const b = createCspNonce();
  assert.notEqual(a, b);
  assert.ok(atob(a).length === 16);
  assert.equal(nonceFromCsp(buildCsp(a)), a);
  assert.equal(nonceFromCsp(null), undefined);
  assert.equal(nonceFromCsp("default-src 'self'"), undefined);
});

test("finalize: HTML gets enforcing CSP + HSTS + XFO + nosniff + referrer + permissions policy", () => {
  const sec = prepareSecurity(secureReq);
  const res = sec.finalize(htmlResponse());
  assert.equal(res.headers.get("content-security-policy"), sec.csp);
  assert.equal(res.headers.get("content-security-policy-report-only"), null);
  assert.equal(res.headers.get("strict-transport-security"), "max-age=31536000");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.match(res.headers.get("permissions-policy")!, /camera=\(\)/);
});

test("finalize: JSON/API responses get the static headers but no CSP; existing headers (Set-Cookie, Cache-Control) are preserved", async () => {
  const sec = prepareSecurity(secureReq);
  const upstream = Response.json({ ok: true }, { headers: { "Set-Cookie": "fpl_edge_session=abc; Path=/; HttpOnly", "Cache-Control": "no-store" } });
  const res = sec.finalize(upstream);
  assert.equal(res.headers.get("content-security-policy"), null);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("set-cookie"), "fpl_edge_session=abc; Path=/; HttpOnly");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { ok: true });
});

test("finalize: works on immutable-header responses (redirects) and keeps status/location", () => {
  const sec = prepareSecurity(secureReq);
  const res = sec.finalize(Response.redirect("https://fpl-edge.example.workers.dev/x", 302));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://fpl-edge.example.workers.dev/x");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

test("report-only mode (FPL_EDGE_CSP_MODE=report-only kill switch) sends Report-Only instead of enforcing; other headers still enforced", () => {
  const sec = prepareSecurity(secureReq, { cspMode: "report-only" });
  const res = sec.finalize(htmlResponse());
  assert.equal(res.headers.get("content-security-policy"), null);
  assert.equal(res.headers.get("content-security-policy-report-only"), sec.csp);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

test("HSTS is not sent over plain http (local dev), and a client-supplied CSP request header is overwritten", () => {
  const sec = prepareSecurity(new Request("http://localhost:3000/"));
  assert.equal(sec.finalize(htmlResponse()).headers.get("strict-transport-security"), null);
  const h = new Headers({ "content-security-policy": "script-src 'nonce-attacker'", "content-security-policy-report-only": "x" });
  sec.applyToRequestHeaders(h);
  assert.equal(nonceFromCsp(h.get("content-security-policy")), sec.nonce);
  assert.equal(h.get("content-security-policy-report-only"), null);
});

test("layout.tsx stamps the nonce on the theme-init inline script; it is the only app-authored inline script", () => {
  const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /<script nonce=\{nonce\} dangerouslySetInnerHTML=\{\{ __html: themeInitScript \}\} \/>/);
  assert.equal((layout.match(/dangerouslySetInnerHTML/g) ?? []).length, 1);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = `${dir}/${name}`;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(name) && p !== new URL("../app/layout.tsx", import.meta.url).pathname && /dangerouslySetInnerHTML|ld\+json|<script/.test(readFileSync(p, "utf8").replace(/^\s*(\/\/|\*).*$/gm, ""))) offenders.push(p);
    }
  };
  walk(new URL("../app", import.meta.url).pathname);
  assert.deepEqual(offenders, []);
});
test("built worker (dist) serves HTML with enforcing CSP whose nonce matches every inline <script>, and API JSON without CSP", { skip: !existsSync(new URL("../dist/server/index.js", import.meta.url)) }, async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("hdr", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = { ASSETS: { fetch: async () => new Response("nf", { status: 404 }) } };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const res = await worker.fetch(new Request("https://fpl-edge.example.workers.dev/", { headers: { accept: "text/html" } }), env, ctx);
  assert.equal(res.status, 200);
  const csp = res.headers.get("content-security-policy")!;
  assert.ok(csp, "CSP header present on /");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("strict-transport-security"), "max-age=31536000");
  const nonce = nonceFromCsp(csp)!;
  const html = await res.text();
  const tags = html.match(/<script(?![^>]*\bsrc=)[^>]*>/g) ?? [];
  assert.ok(tags.length >= 3, "expected vinext + theme inline scripts");
  for (const tag of tags) assert.ok(tag.includes(`nonce="${nonce}"`), `inline script without nonce: ${tag}`);
  const themeTag = html.match(/<script[^>]*>try\{var s=localStorage/);
  assert.ok(themeTag?.[0].includes(`nonce="${nonce}"`), "theme-init script carries the nonce");
  // a client-supplied CSP request header can't inject its own nonce
  const spoof = await worker.fetch(new Request("https://fpl-edge.example.workers.dev/", { headers: { accept: "text/html", "content-security-policy": "script-src 'nonce-EVIL'" } }), env, ctx);
  assert.doesNotMatch(await spoof.text(), /nonce="EVIL"/);
});
