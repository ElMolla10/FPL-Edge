import assert from "node:assert/strict";
import test from "node:test";
import { runHealthChecksWith } from "../app/api/health/route.ts";

const okFetch = async () => new Response("{}", { status: 200 });

test("both checks pass: database ok, FPL upstream ok", async () => {
  const checks = await runHealthChecksWith(async () => {}, okFetch);
  assert.deepEqual(checks.database, { ok: true });
  assert.deepEqual(checks.fplUpstream, { ok: true });
});

test("database check failing is reported, doesn't throw or skip the FPL check", async () => {
  const checks = await runHealthChecksWith(
    async () => {
      throw new Error("D1 binding unavailable");
    },
    okFetch
  );
  assert.equal(checks.database.ok, false);
  assert.equal(checks.database.detail, "D1 binding unavailable");
  assert.deepEqual(checks.fplUpstream, { ok: true });
});

test("a missing-table error is reported with the specific migrations message, not the raw error", async () => {
  const checks = await runHealthChecksWith(
    async () => {
      throw new Error("D1_ERROR: no such table: users");
    },
    okFetch
  );
  assert.equal(checks.database.ok, false);
  assert.equal(checks.database.detail, "D1 reachable, but migrations not applied");
});

test("FPL upstream returning a non-2xx status is reported as unhealthy with the real status code", async () => {
  const checks = await runHealthChecksWith(async () => {}, async () => new Response("", { status: 503 }));
  assert.equal(checks.fplUpstream.ok, false);
  assert.equal(checks.fplUpstream.detail, "status 503");
});

test("FPL upstream throwing (network error/timeout) is reported as unhealthy, not left unhandled", async () => {
  const checks = await runHealthChecksWith(async () => {}, async () => {
    throw new Error("network error");
  });
  assert.equal(checks.fplUpstream.ok, false);
  assert.equal(checks.fplUpstream.detail, "network error");
});
