import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const r = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("privacy covers the required facts", () => {
  const s = r("app/privacy/page.tsx");
  for (const k of ["official public Fantasy Premier League", "No FPL password", "sign you in", "call changes", "Paymob", "not affiliated with the Premier League", "SUPPORT_EMAIL"]) assert.ok(s.includes(k), k);
});
test("terms: pass tied to account through 31 May 2027, Paymob confirms", async () => {
  const s = r("app/terms/page.tsx");
  assert.match(s, /tied to your FPL Edge account/); assert.match(s, /PASS_END_DATE_LABEL/); assert.match(s, /Paymob confirms/);
  const site = await import("../app/lib/site.ts");
  assert.equal(site.PASS_END_DATE_LABEL, "31 May 2027");
  assert.ok(site.SUPPORT_EMAIL.includes("@"));
});
test("legal links on footer, signin and season-pass box (/pay)", () => {
  for (const f of ["app/page.tsx", "app/signin/page.tsx", "app/components/SeasonPass.tsx"]) assert.match(r(f), /<LegalLinks \/>/, f);
  const sp = r("app/components/SeasonPass.tsx");
  assert.match(sp, /Paymob confirms before the pass turns on/);
  assert.ok(!/custom domain/i.test(sp));
});
test("robots keeps api/app/demo disallowed; sitemap lists privacy, terms, pay", async () => {
  const robots = r("app/robots.ts");
  for (const d of ['"/api/"', '"/*?app="', '"/*?demo="']) assert.ok(robots.includes(d));
  const { PUBLIC_PATHS } = await import("../app/lib/site.ts");
  for (const p of ["/privacy", "/terms", "/pay"]) assert.ok((PUBLIC_PATHS as readonly string[]).includes(p));
});
