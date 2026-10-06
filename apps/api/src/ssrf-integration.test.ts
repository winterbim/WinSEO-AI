// ─── SSRF Integration Test ───
// Validates that the public-scan API endpoints reject private IPs
// via the guardUrl/normalizeUrl chain BEFORE any network request.
// Blueprint §12.2, P-GAP-01 gate.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./server.ts";
import type { FastifyInstance } from "fastify";
import { createFixtureAuditRunner } from "./audit/fixture-audit.ts";

const SSRF_PAYLOADS: { domain: string; description: string }[] = [
  { domain: "127.0.0.1", description: "IPv4 loopback" },
  { domain: "127.0.0.1:8080", description: "IPv4 loopback with port" },
  { domain: "http://127.0.0.1:8080/admin", description: "IPv4 loopback page URL" },
  { domain: "localhost", description: "localhost hostname" },
  { domain: "10.0.0.1", description: "RFC1918 10.0.0.0/8" },
  { domain: "192.168.1.1", description: "RFC1918 192.168.0.0/16" },
  { domain: "172.16.0.1", description: "RFC1918 172.16.0.0/12" },
  { domain: "169.254.169.254", description: "AWS metadata endpoint" },
  { domain: "0.0.0.0", description: "Unspecified address" },
  { domain: "100.64.0.1", description: "CGNAT 100.64.0.0/10" },
  { domain: "224.0.0.1", description: "Multicast" },
];

const SAFE_DOMAINS = [
  { domain: "example.com", description: "normal public domain" },
  { domain: "www.github.com", description: "well-known domain" },
];

void describe("ssrf-integration", () => {
  let app: FastifyInstance;

  before(async () => {
    // Explicit memory driver: this suite validates the SSRF guard on the request
    // path, not database persistence. DB persistence integration is proven
    // separately by api-persistence.test.ts against real PostgreSQL.
    app = await buildApp({
      driver: "memory",
      auditDomain: createFixtureAuditRunner(),
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  void it("rejects all SSRF payloads before any network request", async () => {
    for (const payload of SSRF_PAYLOADS) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/public-scans",
        payload: { domain: payload.domain },
      });

      // Must NOT return 201 (Created) — the guard must block before the scan runs
      assert.notEqual(
        res.statusCode,
        201,
        `SSRF payload "${payload.description}" (${payload.domain}) should be rejected, got 201`,
      );

      // Should return 400 (validation) or 500 (internal guard rejection)
      assert.ok(
        res.statusCode >= 400,
        `SSRF payload "${payload.description}" should be in 4xx/5xx, got ${res.statusCode}`,
      );
    }
  });

  void it("accepts safe public domains", async () => {
    for (const safe of SAFE_DOMAINS) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/public-scans",
        payload: { domain: safe.domain },
      });
      assert.equal(
        res.statusCode,
        201,
        `Safe domain "${safe.description}" must pass the URL guard without network access: ${res.body}`,
      );
    }
  });

  void it("accepts a complete public page URL and preserves its path and query", async () => {
    const target = "https://www.github.com/features/actions?source=winseo#details";
    const created = await app.inject({
      method: "POST",
      url: "/v1/public-scans",
      payload: { domain: target },
    });
    assert.equal(created.statusCode, 201, created.body);

    const scanId = (JSON.parse(created.body) as { scanId: string }).scanId;
    const loaded = await app.inject({
      method: "GET",
      url: `/v1/public-scans/${scanId}`,
    });
    assert.equal(loaded.statusCode, 200, loaded.body);
    assert.equal(
      (JSON.parse(loaded.body) as { domain: string }).domain,
      "https://www.github.com/features/actions?source=winseo",
    );
  });

  void it("scan status endpoint returns 404 for unknown scan", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/public-scans/00000000-0000-0000-0000-000000000000",
    });
    assert.equal(res.statusCode, 404);
  });
});
