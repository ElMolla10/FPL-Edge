import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { THEME_KEY, LEGACY_THEME_KEY, themeInitScript, resolveTheme } from "../app/lib/theme.ts";

// Executes the real inline <head> script (app/lib/theme.ts -> app/layout.tsx, stamped with the CSP nonce). It is the source of truth for the
// identity's rule "dark on every first visit, regardless of the OS colour scheme; light only after an explicit toggle click".
function run(storage: Record<string, string> | "throws", prefersLight = false) {
  const writes: Record<string, string> = {};
  let attr: string | null = null;
  let themeColor: string | null = null;
  const doc = {
    documentElement: { setAttribute: (name: string, value: string) => { if (name === "data-theme") attr = value; } },
    querySelector: (sel: string) => (sel.includes("theme-color") ? { setAttribute: (_n: string, v: string) => { themeColor = v; } } : null),
  };
  const ls = {
    getItem: (k: string) => { if (storage === "throws") throw new Error("blocked"); return k in storage ? storage[k] : null; },
    setItem: (k: string, v: string) => { writes[k] = v; },
  };
  // matchMedia is provided on purpose: the script must never consult it
  const matchMedia = () => { throw new Error("prefers-color-scheme must be ignored"); };
  new Function("localStorage", "document", "matchMedia", themeInitScript)(ls, doc, matchMedia);
  void prefersLight;
  return { attr, themeColor, writes };
}

test("fresh visit (nothing stored) is dark, even when the OS prefers light", () => {
  assert.deepEqual(run({}, true), { attr: "dark", themeColor: null, writes: {} });
});

test("legacy explicit choice: old fpl-edge-theme=light (written only by the old toggle click) stays light and is migrated into the v2 key", () => {
  const r = run({ [LEGACY_THEME_KEY]: "light" });
  assert.equal(r.attr, "light");
  assert.equal(r.themeColor, "#F7F7F5");
  assert.deepEqual(r.writes, { [THEME_KEY]: "light" });
});

test("legacy dark / garbage / absent starts dark and writes nothing", () => {
  for (const v of ["dark", "system", "auto", "", "LIGHT"]) {
    const r = run({ [LEGACY_THEME_KEY]: v }, true);
    assert.equal(r.attr, "dark");
    assert.deepEqual(r.writes, {});
  }
});

test("a v2 choice wins over the legacy key (user toggled back to dark after migrating)", () => {
  assert.equal(run({ [THEME_KEY]: "dark", [LEGACY_THEME_KEY]: "light" }).attr, "dark");
});

test("the old code only wrote the legacy key from the toggle click (documented from origin/main source)", () => {
  const doc = readFileSync(fileURLToPath(new URL("../docs/BRAND-IDENTITY.md", import.meta.url)), "utf8");
  assert.match(doc, /fpl-edge-theme/);
  assert.match(doc, /migrat/i);
});

test("garbage in the v2 key falls back to dark", () => {
  assert.equal(run({ [THEME_KEY]: "system" }).attr, "dark");
  assert.equal(run({ [THEME_KEY]: "" }).attr, "dark");
});

test("an explicit stored light choice persists and updates the theme-color meta", () => {
  assert.deepEqual(run({ [THEME_KEY]: "light" }), { attr: "light", themeColor: "#F7F7F5", writes: {} });
});

test("an explicit stored dark choice stays dark", () => {
  assert.equal(run({ [THEME_KEY]: "dark" }).attr, "dark");
});

test("blocked storage fails safe: no throw, CSS default (dark) applies", () => {
  assert.doesNotThrow(() => run("throws"));
  assert.equal(run("throws").attr, null);
});

test("resolveTheme only ever yields light for a literal 'light'", () => {
  assert.equal(resolveTheme("light"), "light");
  for (const v of [null, undefined, "", "dark", "LIGHT", "system", "auto"]) assert.equal(resolveTheme(v as string | null), "dark");
});

test("the script is stamped with the CSP nonce, <html> defaults to data-theme=dark, and the old key / prefers-color-scheme are gone", () => {
  const layout = readFileSync(fileURLToPath(new URL("../app/layout.tsx", import.meta.url)), "utf8");
  assert.match(layout, /<script nonce=\{nonce\} dangerouslySetInnerHTML=\{\{ __html: themeInitScript \}\} \/>/);
  assert.match(layout, /<html lang="en" data-theme="dark"/);
  assert.doesNotMatch(themeInitScript, /matchMedia|prefers-color-scheme/);
  assert.doesNotMatch(readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8"), /prefers-color-scheme/);
});

test("only the toggle's click handler writes the stored choice", () => {
  const toggle = readFileSync(fileURLToPath(new URL("../app/components/ThemeToggle.tsx", import.meta.url)), "utf8");
  const writes = toggle.match(/localStorage\.setItem\(/g) ?? [];
  assert.equal(writes.length, 1);
  assert.ok(toggle.indexOf("localStorage.setItem(") > toggle.indexOf("const toggle = () =>"), "the write sits inside the click handler");
  assert.match(toggle, /aria-pressed=\{theme === "light"\}/);
  assert.match(toggle, /aria-label="Light theme"/);
});
