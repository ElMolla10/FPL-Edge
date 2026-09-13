import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Extracts and executes the actual inline script layout.tsx ships in <head> (not a
// re-implementation of it) -- this is the source of truth for the app's dark-by-default
// behavior (step 3 of the fpl.page redesign), and it runs before React ever mounts, so it
// can't be exercised through a normal component render.
const layoutSource = readFileSync(fileURLToPath(new URL("../app/layout.tsx", import.meta.url)), "utf8");
const match = layoutSource.match(/const themeInitScript = `([^`]+)`;/);
if (!match) throw new Error("themeInitScript template literal not found in app/layout.tsx");
const themeInitScript = match[1];

function runThemeInitScript(storedValue: string | null) {
  let attr: string | null = null;
  const sandbox = {
    localStorage: { getItem: () => storedValue },
    document: { documentElement: { setAttribute: (name: string, value: string) => { if (name === "data-theme") attr = value; } } },
  };
  new Function("localStorage", "document", themeInitScript)(sandbox.localStorage, sandbox.document);
  return attr;
}

test("theme-init script defaults to dark when no preference is stored", () => {
  assert.equal(runThemeInitScript(null), "dark");
});

test("theme-init script defaults to dark for a garbage/legacy stored value", () => {
  assert.equal(runThemeInitScript("system"), "dark");
});

test("theme-init script respects an explicit stored dark override", () => {
  assert.equal(runThemeInitScript("dark"), "dark");
});

test("theme-init script respects an explicit stored light override", () => {
  assert.equal(runThemeInitScript("light"), "light");
});

test("theme-init script fails safe to no attribute set if localStorage throws", () => {
  let attr: string | null = null;
  const sandbox = {
    localStorage: { getItem: () => { throw new Error("blocked"); } },
    document: { documentElement: { setAttribute: (name: string, value: string) => { if (name === "data-theme") attr = value; } } },
  };
  assert.doesNotThrow(() => new Function("localStorage", "document", themeInitScript)(sandbox.localStorage, sandbox.document));
  assert.equal(attr, null);
});
