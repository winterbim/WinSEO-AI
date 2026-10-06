// ─── Public-scan rate limiter tests (P-GAP-06) ───
// Part 1: unit semantics of the limiter (fake clock, no time dependence).
// Part 2: the REAL route honours it (429 + Retry-After) and the loopback
//         exemption plus "rejected requests don't consume quota" hold.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter, isLoopback } from "./rate-limit.ts";
import { buildApp } from "./server.ts";
import type { FastifyInstance } from "fastify";
import { createFixtureAuditRunner } from "./audit/fixture-audit.ts";

void describe("rate-limit unit semantics", () => {
  void it("allows exactly N requests per window, then rejects with retryAfter", () => {
    const t = 1_000_000;
    const rl = createRateLimiter(3, () => t);

    assert.equal(rl.hit("203.0.113.7").allowed, true);
    assert.equal(rl.hit("203.0.113.7").allowed, true);
    const third = rl.hit("203.0.113.7");
    assert.equal(third.allowed, true);
    assert.equal(third.remaining, 0);

    const fourth = rl.hit("203.0.113.7");
    assert.equal(fourth.allowed, false, "N+1th request must be rejected");
    assert.ok(fourth.retryAfterSeconds > 0, "must advertise a retry-after");
    assert.ok(fourth.retryAfterSeconds <= 3600, "retry-after must be within the window");
  });

  void it("windows reset after the interval", () => {
    let t = 1_000_000;
    const rl = createRateLimiter(1, () => t);
    assert.equal(rl.hit("198.51.100.1").allowed, true);
    assert.equal(rl.hit("198.51.100.1").allowed, false);
    t += 60 * 60 * 1000 + 1; // past the window
    assert.equal(rl.hit("198.51.100.1").allowed, true, "window must reset");
  });

  void it("tracks IPs independently", () => {
    const rl = createRateLimiter(1);
    assert.equal(rl.hit("198.51.100.1").allowed, true);
    assert.equal(rl.hit("198.51.100.1").allowed, false);
    assert.equal(rl.hit("198.51.100.2").allowed, true, "another IP must have its own quota");
  });

  void it("loopback is exempt (operator/dev) and cannot be exhausted", () => {
    const rl = createRateLimiter(1);
    for (let i = 0; i < 50; i++) {
      assert.equal(rl.hit("127.0.0.1").allowed, true, `loopback request ${i}`);
      assert.equal(rl.hit("::1").allowed, true, `ipv6 loopback request ${i}`);
    }
  });

  void it("isLoopback recognises the loopback forms", () => {
    assert.ok(isLoopback("127.0.0.1"));
    assert.ok(isLoopback("127.5.6.7"));
    assert.ok(isLoopback("::1"));
    assert.ok(isLoopback("::ffff:127.0.0.1"));
    assert.ok(!isLoopback("203.0.113.7"));
    assert.ok(!isLoopback("8.8.8.8"));
    assert.ok(!isLoopback("128.0.0.1"), "128.x is NOT loopback");
  });
});

void describe("rate limit enforced by the real POST /v1/public-scans route", () => {
  let app: FastifyInstance;

  // The limiter is in-process state created per buildApp, so this suite has
  // its own fresh quota. Memory driver: the limiter is route logic, not DB
  // logic — persistence is proven separately (P-GAP-02/04).
  const REMOTE_IP = "203.0.113.77";

  async function postScan(remoteAddress?: string): Promise<{
    status: number;
    headers: Record<string, unknown>;
    body: string;
  }> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/public-scans",
      payload: { domain: "nonexistent-limit-test.example" },
      ...(remoteAddress ? { remoteAddress } : {}),
    });
    return {
      status: res.statusCode,
      headers: res.headers,
      body: res.body,
    };
  }

  void it("SSRF-rejected requests do NOT consume quota; created scans do; then 429 with Retry-After", async () => {
    app = await buildApp({
      driver: "memory",
      auditDomain: createFixtureAuditRunner(),
    });
    await app.ready();

    // 5 SSRF rejections from the same IP — must not decrement the quota.
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/public-scans",
        payload: { domain: "127.0.0.1" },
        remoteAddress: REMOTE_IP,
      });
      assert.equal(res.statusCode, 400, `SSRF attempt ${i} must stay 400`);
    }

    // Default limit is 10/hour: 10 created scans must all be accepted...
    for (let i = 0; i < 10; i++) {
      const r = await postScan(REMOTE_IP);
      assert.equal(r.status, 201, `scan #${i + 1} must be accepted, got ${r.status}`);
    }

    // ...and the 11th must be 429 with a Retry-After header.
    const blocked = await postScan(REMOTE_IP);
    assert.equal(blocked.status, 429, `expected 429, got ${blocked.status}: ${blocked.body}`);
    const body = JSON.parse(blocked.body) as { error: { code: string } };
    assert.equal(body.error.code, "RATE_LIMITED");
    assert.ok(blocked.headers["retry-after"], "Retry-After header must be present");

    // Loopback remains exempt even after the remote IP is exhausted.
    const lb = await postScan();
    assert.equal(lb.status, 201, "loopback must stay exempt");

    await app.close();
  });
});
