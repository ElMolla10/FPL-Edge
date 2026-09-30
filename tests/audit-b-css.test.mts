import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const has = (selector: string) => css.includes(selector);

test("classes built from data or template strings kept their rules", () => {
  // DecisionConfidencePanel: label.toLowerCase().replaceAll(" ", "-") -> robust | close-call | high-risk
  for (const cls of [".robust", ".close-call", ".high-risk"]) assert.ok(has(cls), `${cls} rule must exist`);
  // template-string families
  for (const cls of [".fdr-1", ".fdr-5", ".status-a", ".row-gkp", ".quality-", ".engine-"]) {
    assert.ok(has(cls), `${cls} rule family must exist`);
  }
});

test("shared shell and app surfaces survive", () => {
  for (const cls of [".coach-shell", ".coach-sidebar", ".coach-loading", ".best-decision-metrics", ".price-value-alert", ".decision-confidence", ".coach-pitch-player"]) {
    assert.ok(has(cls), `${cls} rule must exist`);
  }
});

test("dead-CSS audit script finds no remaining unused selectors", () => {
  const out = execFileSync(process.execPath, ["scripts/audit-unused-css.mjs"], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.match(out, /^0 candidate dead rule/m);
});
