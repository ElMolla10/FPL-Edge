#!/usr/bin/env node
// Lint ratchet: fail only on NEW ESLint errors versus the checked-in baseline
// (.github/lint-baseline.json, a map of repo-relative file -> error count).
//
// Why: the repo had ~200 pre-existing lint errors when CI lint was introduced. A blocking
// `eslint .` would have made CI red on day one and blocked deploys; `continue-on-error` gives no
// signal at all. The ratchet blocks regressions (any file whose error count grows, or any file
// that was clean and now has errors) while letting the backlog be paid down over time.
//
// Usage:
//   node scripts/lint-ratchet.mjs            # check (CI)
//   node scripts/lint-ratchet.mjs --update   # rewrite the baseline (only ever to LOWER counts)
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(root, ".github", "lint-baseline.json");
const update = process.argv.includes("--update");

/** Pure comparison, exported for tests. Returns { regressions, improvements }. */
export function compareToBaseline(current, baseline) {
  const regressions = [];
  const improvements = [];
  for (const [file, count] of Object.entries(current)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) regressions.push({ file, allowed, count });
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const count = current[file] ?? 0;
    if (count < allowed) improvements.push({ file, allowed, count });
  }
  return { regressions, improvements };
}

function runEslint() {
  const bin = path.join(root, "node_modules", ".bin", "eslint");
  const result = spawnSync(bin, [".", "--ignore-pattern", "dist", "--ignore-pattern", ".next", "-f", "json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  // ESLint exits 1 when there are lint errors (expected here) and 2 on a crash/config error.
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    console.error(result.stderr || String(result.error));
    process.exit(2);
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    console.error("lint-ratchet: could not parse ESLint JSON output");
    console.error(result.stderr);
    process.exit(2);
  }
  const counts = {};
  let warnings = 0;
  for (const file of report) {
    warnings += file.warningCount;
    if (file.errorCount > 0) counts[path.relative(root, file.filePath).split(path.sep).join("/")] = file.errorCount;
  }
  return { counts, warnings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { counts, warnings } = runEslint();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));

  if (update) {
    // First run creates the baseline; afterwards it may only go down.
    const previous = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : null;
    const { regressions } = previous ? compareToBaseline(counts, previous) : { regressions: [] };
    if (regressions.length > 0) {
      console.error("lint-ratchet: refusing to --update while there are regressions (the baseline may only go down):");
      for (const r of regressions) console.error(`  ${r.file}: ${r.count} > ${r.allowed}`);
      process.exit(1);
    }
    writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`lint-ratchet: baseline updated (${total} errors across ${Object.keys(sorted).length} files).`);
    process.exit(0);
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const baselineTotal = Object.values(baseline).reduce((a, b) => a + b, 0);
  const { regressions, improvements } = compareToBaseline(counts, baseline);
  console.log(`lint-ratchet: ${total} errors now vs ${baselineTotal} in baseline (${warnings} warnings, not gated).`);
  if (improvements.length > 0) {
    console.log(`lint-ratchet: ${improvements.length} file(s) improved; run \`node scripts/lint-ratchet.mjs --update\` and commit to lock in the gain.`);
  }
  if (regressions.length > 0) {
    console.error("lint-ratchet: NEW lint errors (fix them, do not raise the baseline):");
    for (const r of regressions) console.error(`  ${r.file}: ${r.count} errors (baseline ${r.allowed})`);
    console.error("Run `npm run lint` for details.");
    process.exit(1);
  }
  console.log("lint-ratchet: OK (no new lint errors).");
}
