import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const walk = (dir: string): string[] =>
  readdirSync(join(root, dir)).flatMap((name) => {
    const rel = join(dir, name);
    return statSync(join(root, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(name) ? [rel] : [];
  });
const BOT_FILES = [...walk("app/lib/fpl-bot"), ...walk("app/api/bot"), ...walk("app/bot")];
const src = (rel: string) => readFileSync(join(root, rel), "utf8");

test("bot code never reaches the personal account: no personal store, token, env, table or keep-alive", () => {
  const banned = [/personal_fpl_auth/, /PERSONAL_FPL_REFRESH_TOKEN/, /FPL_EDGE_PERSONAL_FPL_REFRESH_TOKEN/, /PERSONAL_TRANSFER_/, /personal-fpl-transfer\/(store|keep-alive|live-team|index|chip-state)/, /personal-fpl-transfer["']/, /keepAlivePersonalFplAuth/];
  for (const file of BOT_FILES) for (const re of banned) assert.doesNotMatch(src(file), re, `${file} matches ${re}`);
});

test("bot imports from personal-fpl-transfer are limited to the pure OIDC / rotation / FT helpers", () => {
  const allowed: Record<string, Set<string>> = {
    client: new Set(["createRotatingTokenProvider", "TokenProvider", "type TokenProvider"]),
    oidc: new Set(["FplOidcError", "exchangeRefreshToken"]),
    config: new Set(["extractRefreshToken"]),
    "ft-state": new Set(["remainingFreeTransfers"]),
  };
  for (const file of BOT_FILES) {
    for (const m of src(file).matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+["'][./]*(?:lib\/)?personal-fpl-transfer\/([\w-]+)["']/g)) {
      const mod = m[3];
      assert.ok(allowed[mod], `${file} imports personal-fpl-transfer/${mod}`);
      for (const name of m[2].split(",").map((s) => s.trim()).filter(Boolean)) assert.ok(allowed[mod].has(name), `${file} imports ${name} from ${mod}`);
    }
  }
});

test("only PERSONAL_FPL_ENTRY_ID is read by bot config, and only for the != assertion", () => {
  const personalRefs = BOT_FILES.flatMap((f) => (src(f).match(/FPL_EDGE_PERSONAL_\w+/g) ?? []).map((v) => `${f}:${v}`));
  assert.deepEqual([...new Set(personalRefs)], ["app/lib/fpl-bot/config.ts:FPL_EDGE_PERSONAL_FPL_ENTRY_ID"]);
});

test("FPL write calls exist only in the bot client and the cron runner", () => {
  const all = [...walk("app"), ...walk("worker")];
  const writers = all.filter((f) => /\.(postTransfers|postPicks|armPosts)\(/.test(src(f)));
  assert.deepEqual(writers.sort(), ["app/lib/fpl-bot/runner.ts"]);
  assert.match(src("app/lib/fpl-bot/fpl-client.ts"), /if \(!this\.allowPost\) throw/);
});

test("bot routes are owner-gated, and every mutating route rejects cross-site requests", () => {
  for (const file of walk("app/api/bot")) {
    const s = src(file);
    assert.match(s, /getCurrentUser\(/, `${file} must resolve the session`);
    assert.match(s, /evaluateBotOwnerGate\(/, `${file} must apply the owner gate`);
    if (/export async function POST/.test(s)) assert.match(s, /rejectCrossSite\(/, `${file} POST must reject cross-site`);
    assert.doesNotMatch(s, /export async function (PUT|DELETE|PATCH)/);
  }
});

test("no owner PII or bot entry id is committed", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter((f) => f && !/\.(png|jpe?g|webp|woff2?|ico)$/.test(f));
  // Owner identifiers kept out of the source in plain text (base64), so this test does not itself leak them.
  const pii = ["aW1vZHkxMEBnbWFpbC5jb20=", "MjYxNTkz", "aW1vZHkxMA=="].map((b) => Buffer.from(b, "base64").toString("utf8"));
  for (const file of tracked) {
    let text: string;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    for (const needle of pii) assert.ok(!text.includes(needle), `${file} contains owner PII`);
  }
});

test("bot tables are created by an idempotent, journaled migration", () => {
  const sql = src("drizzle/0012_fpl_bot.sql");
  for (const table of ["bot_fpl_auth", "bot_state", "bot_lock", "bot_runs", "bot_decisions", "bot_posts", "bot_errors"]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS \`?${table}\`?`));
  assert.match(sql, /UNIQUE|PRIMARY KEY/);
  const journal = JSON.parse(src("drizzle/meta/_journal.json"));
  assert.ok(journal.entries.some((e: { tag: string }) => e.tag === "0012_fpl_bot"));
});
