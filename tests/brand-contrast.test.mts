import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// WCAG 2.x contrast of the identity's token pairs, read from app/globals.css (the real tokens, not copies), for BOTH themes.
const css = readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8");
function tokens(block: RegExp): Record<string, string> {
  const body = css.match(block)?.[1] ?? "";
  return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+):(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]]));
}
const dark = tokens(/:root\{([^}]*)\}/);
const light = { ...dark, ...tokens(/\[data-theme="light"\]\{([^}]*)\}/) };
function lum(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function ratio(a: string, b: string) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// [foreground token, background token, minimum]. 4.5 = normal text, 3 = controls / focus / large text.
const PAIRS: [string, string, number][] = [
  ["--text", "--canvas", 4.5], ["--text", "--surface", 4.5], ["--text", "--surface-raised", 4.5],
  ["--text-muted", "--canvas", 4.5], ["--text-muted", "--surface", 4.5], ["--text-muted", "--surface-raised", 4.5],
  ["--on-lime", "--lime", 4.5], ["--on-lime", "--lime-hover", 4.5],
  ["--accent-text", "--canvas", 4.5], ["--accent-text", "--surface", 4.5], ["--accent-text", "--surface-raised", 4.5],
  ["--positive-text", "--surface", 4.5], ["--positive-text", "--canvas", 4.5], ["--positive-text", "--surface-raised", 4.5],
  ["--warning-text", "--surface", 4.5], ["--warning-text", "--canvas", 4.5], ["--warning-text", "--surface-raised", 4.5],
  ["--negative-text", "--surface", 4.5], ["--negative-text", "--canvas", 4.5], ["--negative-text", "--surface-raised", 4.5],
  ["--success-text", "--success-bg", 4.5], ["--danger-text", "--danger-bg", 4.5], ["--info-text", "--info-bg", 4.5],
  ["--warning-text", "--warning-bg", 4.5],
  ["--selected-text", "--selected-bg", 4.5],
  ["--fdr-ink", "--fdr-1", 4.5], ["--fdr-ink", "--fdr-2", 4.5], ["--fdr-ink", "--fdr-3", 4.5], ["--fdr-ink", "--fdr-4", 4.5], ["--fdr-ink", "--fdr-5", 4.5],
  // non-text: focus outline and the secondary-button outline against the surfaces they sit on
  ["--focus", "--canvas", 3], ["--focus", "--surface", 3], ["--focus", "--surface-raised", 3],
  ["--text-muted", "--canvas", 3],
];
for (const [name, theme] of [["dark", dark], ["light", light]] as const) {
  for (const [fg, bg, min] of PAIRS) {
    test(`${name}: ${fg} on ${bg} >= ${min}:1`, () => {
      assert.ok(theme[fg] && theme[bg], `tokens ${fg}/${bg} must be defined as #hex in globals.css`);
      const r = ratio(theme[fg], theme[bg]);
      assert.ok(r >= min, `${theme[fg]} on ${theme[bg]} = ${r.toFixed(2)}:1 (< ${min})`);
    });
  }
}

test("never lime text on white / light surfaces: light-theme accent text is near-black", () => {
  assert.notEqual(light["--accent-text"].toLowerCase(), light["--lime"].toLowerCase());
  assert.ok(ratio(light["--accent-text"], light["--surface"]) >= 4.5);
});

test("the brand palette is exactly the identity's (design-tokens.json)", () => {
  assert.deepEqual(
    [dark["--canvas"], dark["--surface"], dark["--surface-raised"], dark["--border"], dark["--text"], dark["--text-muted"], dark["--lime"], dark["--positive"], dark["--warning"], dark["--negative"]],
    ["#121614", "#18201B", "#1F2A23", "#35443A", "#F7F7F5", "#B3BEB5", "#B9F43B", "#66D9A0", "#F5C76B", "#FF8D91"],
  );
  assert.deepEqual([light["--canvas"], light["--surface"], light["--text"], light["--text-muted"], light["--border"], light["--surface-raised"]], ["#F7F7F5", "#FFFFFF", "#121614", "#526057", "#D7DFD8", "#EDF2EC"]);
});
