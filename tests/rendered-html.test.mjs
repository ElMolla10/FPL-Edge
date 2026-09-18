import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("renders production site metadata", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const html = await response.text();
  assert.match(html, /<title>FPL Edge<\/title>/i);
  assert.match(html, /<meta(?=[^>]*\bname=["']description["'])(?=[^>]*\bcontent=["']A lineup, a captain, and whether to transfer\. Free this gameweek\.["'])[^>]*>/i);
  assert.doesNotMatch(html, /<meta(?=[^>]*\bname=["']codex-preview["'])[^>]*>/i);
});

test("marketing homepage is the paper desk, not the poster", () => {
  const home = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(home, /This week&apos;s move\./);
  assert.match(home, /Check your FPL team/);
  assert.doesNotMatch(home, /Open the desk/);
  assert.match(home, /What the desk answers/);
  assert.match(home, /Free this week/);
  assert.match(home, /Get the season pass/);
  assert.match(home, /href="\/pay"/);
  assert.match(home, /Example, until you connect a team\./);
  assert.match(home, /Through 31 May 2027\./);
  assert.match(home, /params\.get\("app"\) === "1"/);
  assert.match(home, /<CoachApp /);
  assert.doesNotMatch(home, /Stop guessing|Win the decision|Hours of research|Three steps|Not AI says so|Make the move you can defend|See how it works|04:52:18|GW 1|gameweek 1/i);
  assert.doesNotMatch(home, /faq-section|proof-strip|15\/15|\+8\.4/);
});
