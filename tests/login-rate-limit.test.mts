import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  LOGIN_RATE_LIMIT,
  clientIpFromRequest,
  evaluateLoginRateLimit,
  normalizeLoginEmail,
  rateLimitKeys,
  registerLoginFailure,
} from "../app/lib/login-rate-limit.ts";

test("normalizeLoginEmail lowercases and trims", () => {
  assert.equal(normalizeLoginEmail("  A@B.Com "), "a@b.com");
});

test("rateLimitKeys separate email and ip namespaces", () => {
  assert.deepEqual(rateLimitKeys("A@B.com", "1.2.3.4"), {
    emailKey: "email:a@b.com",
    ipKey: "ip:1.2.3.4",
  });
});

test("clientIpFromRequest prefers cf-connecting-ip", () => {
  const request = new Request("https://example.com", {
    headers: {
      "cf-connecting-ip": "9.9.9.9",
      "x-forwarded-for": "1.1.1.1, 2.2.2.2",
    },
  });
  assert.equal(clientIpFromRequest(request), "9.9.9.9");
});

test("evaluateLoginRateLimit blocks when either bucket is locked", () => {
  const now = Date.parse("2026-09-28T12:00:00.000Z");
  const blocked = evaluateLoginRateLimit(
    [{ kind: "email", failCount: 5, windowStartedAt: "2026-09-28T11:50:00.000Z", blockedUntil: "2026-09-28T12:10:00.000Z" }],
    now,
  );
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.reason, "email");
    assert.equal(blocked.retryAfterSeconds, 600);
  }
  const open = evaluateLoginRateLimit(
    [{ kind: "ip", failCount: 2, windowStartedAt: "2026-09-28T11:50:00.000Z", blockedUntil: null }],
    now,
  );
  assert.equal(open.ok, true);
});

test("registerLoginFailure locks after maxFails inside the window", () => {
  const t0 = Date.parse("2026-09-28T12:00:00.000Z");
  let bucket = registerLoginFailure(null, "email:a@b.com", "email", t0);
  for (let i = 1; i < LOGIN_RATE_LIMIT.maxFails; i++) {
    bucket = registerLoginFailure(bucket, "email:a@b.com", "email", t0 + i * 1000);
  }
  assert.equal(bucket.failCount, LOGIN_RATE_LIMIT.maxFails);
  assert.ok(bucket.blockedUntil);
  assert.ok(Date.parse(bucket.blockedUntil!) > t0);
});

test("recordLoginFailure store uses atomic SQL increment (no read-modify-write)", () => {
  const src = readFileSync(new URL("../app/lib/login-rate-limit-store.ts", import.meta.url), "utf8");
  assert.match(src, /incrementLoginFailureAtomic/);
  assert.match(src, /ON CONFLICT\(key\) DO UPDATE SET/);
  assert.match(src, /fail_count \+ 1/);
  assert.match(src, /blocked_until/);
  // Must not call registerLoginFailure inside recordLoginFailure (RMW race).
  const recordBody = src.slice(src.indexOf("export async function recordLoginFailure"));
  assert.doesNotMatch(recordBody, /registerLoginFailure/);
});
