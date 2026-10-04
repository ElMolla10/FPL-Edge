import { readAllCss } from "./helpers/all-css.mts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Wordmark } from "../app/components/Wordmark.tsx";
import { readCoachSource } from "./helpers/coach-source.mts";

test("wordmark is one line, FPL then EDGE, with no italic E or tile", () => {
  const html = renderToStaticMarkup(createElement(Wordmark));
  assert.match(html, /class="fpl-wordmark"/);
  assert.match(html, /class="fpl-wordmark-fpl">FPL<\/span> <span class="fpl-wordmark-edge">EDGE<\/span>/);
  assert.doesNotMatch(html, /brand-mark|font-style:italic|>E</);
});

test("headers and the sidebar use the wordmark, not the old italic E", () => {
  // Narrow navigation (app sidebar + header) and the landing footer use the typeset wordmark; every public page header uses the supplied logo tile via PaperHeader.
  for (const file of ["app/components/CoachApp.tsx", "app/page.tsx"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, /<Wordmark\/>/, file);
    assert.doesNotMatch(source, /brand-mark|>FPL EDGE<|>FPL Edge</, file);
  }
  for (const file of ["app/page.tsx", "app/signin/page.tsx", "app/signup/page.tsx", "app/pay/page.tsx", "app/not-found.tsx", "app/error.tsx", "app/components/LegalPage.tsx", "app/components/RouteLoading.tsx"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, /<PaperHeader\b/, file);
    assert.doesNotMatch(source, /brand-mark|>FPL EDGE<|>FPL Edge</, file);
  }
  const coach = readCoachSource();
  const sidebar = coach.slice(coach.indexOf("coach-sidebar"), coach.indexOf("coach-main"));
  const header = coach.slice(coach.indexOf("coach-header"), coach.indexOf("header-tools"));
  assert.match(sidebar, /sidebar-brand[\s\S]*<Wordmark\/>/);
  assert.match(header, /header-wordmark[\s\S]*<Wordmark\/>/);
  const css = readAllCss();
  // FPL lime + EDGE chalk on dark; near-black type with a small lime rule on light (identity guide section 2).
  assert.match(css, /\.fpl-wordmark-fpl\{color:var\(--lime\)\}/);
  assert.match(css, /\.fpl-wordmark-edge\{color:var\(--text\)\}/);
  assert.match(css, /\[data-theme="light"\] \.fpl-wordmark-fpl\{color:var\(--text\);box-shadow:inset 0 -\.2em var\(--lime\)\}/);
  assert.doesNotMatch(css, /\.brand-mark\{[^}]*italic/);
  assert.doesNotMatch(css, /\.header-wordmark \.wordmark-text\{display:none\}/);
});

test("favicon is the rounded dark tile with FPL in the live lime and EDGE in white", () => {
  const svg = readFileSync(new URL("../public/favicon.svg", import.meta.url), "utf8");
  assert.match(svg, /fill="#121614"/);
  assert.match(svg, /rx="112\.64"/);
  assert.match(svg, /fill="#b9f43b"/);
  assert.match(svg, /fill="#F7F7F5"/);
  assert.doesNotMatch(svg, /gradient|drop-shadow|crown|football/i);
  const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /\/favicon\.svg/);
  assert.match(layout, /\/icon-512\.png/);
  assert.match(layout, /\/apple-touch-icon\.png/);
});

test("the logo tile on public pages is the supplied artwork, unchanged: >=48px, no extra container, no recolour", () => {
  const mark = readFileSync(new URL("../app/components/BrandMark.tsx", import.meta.url), "utf8");
  assert.match(mark, /Math\.max\(48, size\)/);
  assert.match(mark, /primary-logo-96\.png/);
  const css = readAllCss();
  assert.match(css, /\.brand-logo\{display:block;width:48px;height:48px;border-radius:0;box-shadow:none\}/);
  assert.doesNotMatch(css, /\.brand-logo[^{]*\{[^}]*(filter|background|border:)/);
  // the supplied 1024px artwork ships next to its two display resamples, byte-identical to the identity pack
  const shipped = readFileSync(new URL("../public/brand/primary-logo-1024.png", import.meta.url));
  assert.equal(shipped.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(shipped.length, 42155);
});
