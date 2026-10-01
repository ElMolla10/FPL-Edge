// Report-only dead-CSS audit for app/globals.css and the split sheets in app/styles/ (audit B item 10).
//   node scripts/audit-unused-css.mjs [--json]
// A class is "used" if its name (or its lower-cased / hyphen-slugged form) appears as an
// identifier or inside any string literal in app/ or worker/ sources, or starts with a prefix
// that source builds dynamically (`fdr-${n}`, "status-" + x, ...). Selectors that use
// [class*=...] are never reported. Exit code is always 0: this is a review aid, not a gate.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import postcss from "postcss";

const root = resolve(import.meta.dirname, "..");
const cssFiles = [join(root, "app/globals.css"), ...readdirSync(join(root, "app/styles")).filter((f) => f.endsWith(".css")).sort().map((f) => join(root, "app/styles", f))];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(tsx?|mts|jsx?|mjs|html|mdx?|json)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const tokens = new Set();
const prefixes = new Set();
const add = (token) => { tokens.add(token); tokens.add(token.toLowerCase()); };
for (const file of [...walk(join(root, "app")), ...walk(join(root, "worker"))]) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/[A-Za-z_][A-Za-z0-9_-]*/g)) add(match[0]);
  for (const match of source.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
    const literal = match[2];
    for (const word of literal.split(/[^A-Za-z0-9_-]+/)) if (word) add(word);
    const slug = literal.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
    if (slug) tokens.add(slug); // class names derived from data: label.toLowerCase().replaceAll(" ", "-")
    for (const part of literal.split(/[^A-Za-z0-9 _-]+/)) {
      const partSlug = part.trim().toLowerCase().replace(/\s+/g, "-");
      if (partSlug) tokens.add(partSlug);
    }
  }
  for (const match of source.matchAll(/([A-Za-z0-9_-]*-)\$\{/g)) prefixes.add(match[1]);
  for (const match of source.matchAll(/["'`]([A-Za-z0-9_ -]*-)["'`]\s*\+/g)) prefixes.add(match[1].split(" ").pop());
}

const used = (name) => tokens.has(name) || [...prefixes].some((prefix) => prefix.length >= 3 && name.startsWith(prefix));
const classesIn = (selector) => [...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
const dynamic = (selector) => /\[class[*^$~|]?=/.test(selector);

const dead = [];
for (const cssPath of cssFiles) postcss.parse(readFileSync(cssPath, "utf8")).walkRules((rule) => {
  if (rule.parent?.type === "atrule" && /keyframes$/.test(rule.parent.name)) return;
  const unused = rule.selectors.filter((selector) => !dynamic(selector) && classesIn(selector).some((name) => !used(name)));
  if (unused.length) dead.push({ file: cssPath.slice(root.length + 1), line: rule.source.start.line, whole: unused.length === rule.selectors.length, selectors: unused });
});

if (process.argv.includes("--json")) console.log(JSON.stringify(dead, null, 1));
else {
  for (const item of dead) console.log(`${item.whole ? "rule    " : "selector"} ${item.file}:L${item.line}: ${item.selectors.join(", ").slice(0, 160)}`);
  console.log(`${dead.length} candidate dead rule(s)/selector(s) in app/globals.css + app/styles/*.css`);
}
