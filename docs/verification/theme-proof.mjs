// Theme proof (Playwright). Usage: node theme-proof.mjs [baseUrl]   (needs a running build and playwright-core)
import { chromium } from "playwright-core";
const B = process.argv[2] || "http://127.0.0.1:8802";
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
let fails = 0; const t = (ok, label, d = "") => { if (!ok) fails++; console.log(ok ? "PASS" : "FAIL", label, d); };
const th = p => p.evaluate(() => document.documentElement.getAttribute("data-theme"));
const get = (p, k) => p.evaluate(k => localStorage.getItem(k), k);
// 1. nothing stored, OS prefers light -> dark
{
  const ctx = await browser.newContext({ colorScheme: "light" }); const p = await ctx.newPage();
  for (const path of ["/", "/signin", "/pay", "/?demo=1", "/terms", "/nope"]) { await p.goto(B + path, { waitUntil: "networkidle" }); t((await th(p)) === "dark" && (await get(p, "fpl-edge-theme-v2")) === null, `absent + colorScheme=light -> dark, nothing written: ${path}`); }
  // 2. toggle persists
  await p.goto(B + "/", { waitUntil: "networkidle" }); await p.locator("button.theme-toggle").first().click();
  t((await th(p)) === "light" && (await get(p, "fpl-edge-theme-v2")) === "light", "toggle click -> light + stored");
  await p.reload({ waitUntil: "networkidle" }); t((await th(p)) === "light", "light persists across reload");
  const p2 = await ctx.newPage(); await p2.goto(B + "/signin", { waitUntil: "networkidle" }); t((await th(p2)) === "light", "light persists in new tab / other route");
  await p.locator("button.theme-toggle").first().click(); await p.reload({ waitUntil: "networkidle" }); t((await th(p)) === "dark" && (await get(p, "fpl-edge-theme-v2")) === "dark", "toggle back -> dark persisted");
  await ctx.close();
}
// 3. legacy key
for (const [legacy, want, wrote] of [["light", "light", "light"], ["dark", "dark", null], ["system", "dark", null], ["auto", "dark", null], [null, "dark", null]]) {
  const ctx = await browser.newContext({ colorScheme: "light" }); const p = await ctx.newPage();
  await p.goto(B + "/signin", { waitUntil: "domcontentloaded" });
  await p.evaluate(v => { localStorage.clear(); if (v !== null) localStorage.setItem("fpl-edge-theme", v); }, legacy);
  await p.reload({ waitUntil: "networkidle" });
  t((await th(p)) === want && (await get(p, "fpl-edge-theme-v2")) === wrote, `legacy fpl-edge-theme=${legacy} -> ${want}${wrote ? " and rewritten into v2" : ", nothing written"}`);
  await ctx.close();
}
// 4. no FOUC: stored light is applied by the inline head script before first paint; script is nonce'd
{
  const ctx = await browser.newContext({ colorScheme: "light", viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("fpl-edge-theme", "light"); }
    window.__t = []; requestAnimationFrame(() => { window.__raf = document.documentElement.getAttribute("data-theme"); window.__rafAt = performance.now(); }); new MutationObserver(() => window.__t.push([document.documentElement.getAttribute("data-theme"), performance.now()])).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-theme"] });
  });
  const p = await ctx.newPage(); const resp = await p.goto(B + "/signin", { waitUntil: "load" });
  const r = await p.evaluate(() => ({ seq: window.__t, raf: window.__raf, rafAt: Math.round(window.__rafAt), paints: performance.getEntriesByType("paint").map(e => [e.name, Math.round(e.startTime)]), nonce: !!document.querySelector("head script:not([src])")?.nonce || !!document.querySelector("head script:not([src])")?.getAttribute("nonce"), inHead: !!document.querySelector("head script:not([src])")?.textContent.includes("fpl-edge-theme-v2") }));
  t(r.seq.length >= 1 && r.seq.every(x => x[0] === "light") && r.raf === "light" && r.seq[0][1] < r.rafAt && r.paints.every(p => p[1] > r.seq[0][1]), "no FOUC: data-theme=light set before first paint, never flips back", JSON.stringify(r));
  t(r.inHead && r.nonce, "theme script is inline in <head> and carries the CSP nonce");
  const csp = resp.headers()["content-security-policy"] || ""; t(/script-src[^;]*'nonce-/.test(csp), "CSP script-src uses a nonce");
  await ctx.close();
}
console.log(fails ? `${fails} FAILED` : "ALL PASS"); await browser.close(); process.exit(fails ? 1 : 0);
