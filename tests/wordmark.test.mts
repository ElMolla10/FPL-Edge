import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Wordmark } from "../app/components/Wordmark.tsx";

test("wordmark is one line, FPL then EDGE, with no italic E or tile", () => {
  const html = renderToStaticMarkup(createElement(Wordmark));
  assert.match(html, /class="fpl-wordmark"/);
  assert.match(html, /class="fpl-wordmark-fpl">FPL<\/span> <span class="fpl-wordmark-edge">EDGE<\/span>/);
  assert.doesNotMatch(html, /brand-mark|font-style:italic|>E</);
});

test("headers and the sidebar use the wordmark, not the old italic E", () => {
  const files = [
    "app/components/CoachApp.tsx",
    "app/page.tsx",
    "app/signin/page.tsx",
    "app/signup/page.tsx",
    "app/pay/page.tsx",
  ];
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, /<Wordmark\/>/, file);
    assert.doesNotMatch(source, /brand-mark|>FPL EDGE<|>FPL Edge</, file);
  }
  const coach = readFileSync(new URL("../app/components/CoachApp.tsx", import.meta.url), "utf8");
  const sidebar = coach.slice(coach.indexOf("coach-sidebar"), coach.indexOf("coach-main"));
  const header = coach.slice(coach.indexOf("coach-header"), coach.indexOf("header-tools"));
  assert.match(sidebar, /sidebar-brand[\s\S]*<Wordmark\/>/);
  assert.match(header, /header-wordmark[\s\S]*<Wordmark\/>/);
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.fpl-wordmark-fpl\{color:var\(--lime\)/);
  assert.match(css, /\.fpl-wordmark-edge\{color:#F7F7F5;font-weight:800;font-size:1\.15em/);
  assert.match(css, /\[data-theme="light"\] \.fpl-wordmark-edge\{color:#161916\}/);
  assert.match(css, /\.coach-sidebar \.fpl-wordmark-edge\{color:#F7F7F5\}/);
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
