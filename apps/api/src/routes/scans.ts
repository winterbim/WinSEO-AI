import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logger, generateTraceId } from "@serpvera/telemetry";
import { guardUrl, normalizeAuditTarget } from "@serpvera/crawler";
import type { ScanStore } from "../stores/types.ts";

// ─── Public-scan quota (P-GAP-06) ───
// Per-IP hourly window; only scans that actually get created consume quota
// (validation/SSRF rejections are free). Loopback exempt (operator/dev).
const PUBLIC_SCAN_RATE_LIMIT = Math.max(
  1,
  parseInt(process.env.PUBLIC_SCAN_RATE_LIMIT_PER_HOUR ?? "10", 10) || 10,
);

export function scanRoutes(app: FastifyInstance) {
  // POST /v1/public-scans — free audit, anonymous (Blueprint §8.2)
  app.post("/", async (request, reply) => {
    const schema = z.object({
      domain: z.string().trim().min(1).max(2048),
    });

    const body = schema.parse(request.body);
    let targetUrl: string;
    try {
      targetUrl = normalizeAuditTarget(body.domain).normalized;
    } catch {
      return reply.status(400).send({
        error: { code: "INVALID_URL", message: "Enter a valid HTTP or HTTPS URL." },
      });
    }

    // ─── SSRF guard BEFORE queueing (Blueprint §12.2) ───
    // Must be synchronous in the request path: the scan runs async, so guarding
    // only inside runScan would return 201 for a blocked target first.
    try {
      guardUrl(targetUrl);
    } catch (ssrfErr) {
      logger.warn("Public scan rejected by SSRF guard", {
        jobType: "public-scan",
        error: (ssrfErr as Error).message,
      });
      return reply.status(400).send({
        error: {
          code: "SSRF_BLOCKED",
          message: "URL rejected by security policy: only public internet targets are allowed.",
        },
      });
    }

    // ─── Rate limit (P-GAP-06): AFTER validation/SSRF, BEFORE creating the
    // scan — only scans that actually run consume quota. Loopback (operator/
    // dev) is exempt inside the limiter, so local proofs stay repeatable. ───
    const decision = await app.stores.rateLimits.hit(request.ip, PUBLIC_SCAN_RATE_LIMIT);
    if (!decision.allowed) {
      reply.header("retry-after", String(decision.retryAfterSeconds));
      return reply.status(429).send({
        error: {
          code: "RATE_LIMITED",
          message: `Rate limit exceeded: ${PUBLIC_SCAN_RATE_LIMIT} public scans per hour from your address. Retry in ${decision.retryAfterSeconds}s.`,
        },
      });
    }

    const scan = await app.stores.scans.createPublicScan(targetUrl);

    // Fire-and-forget; the worker updates the store and errors are recorded there.
    void runScan(scan.id, targetUrl, app.stores.scans, app.auditDomain);

    return reply.status(201).send({
      scanId: scan.id,
      status: "pending",
      estimatedSeconds: 15,
    });
  });

  // GET /v1/public-scans/:scanId — access gated by unguessable UUID
  app.get("/:scanId", async (request, reply) => {
    const params = z.object({ scanId: z.uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "INVALID_ID", message: "Scan id must be a UUID." },
      });
    }

    const scan = await app.stores.scans.getPublicScan(params.data.scanId);
    if (!scan) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Scan not found." },
      });
    }

    return reply.send({
      scanId: scan.id,
      domain: scan.domain,
      status: scan.status,
      createdAt: scan.createdAt,
      completedAt: scan.completedAt,
      findings: scan.findings,
      evidence: scan.evidence,
      error: scan.error,
    });
  });
}

// ─── Async scan worker (deterministic checks; no LLM) ───
// The store is passed explicitly — no module-level mutable state, so the same
// code runs identically against PostgreSQL and the in-memory test adapter.
async function runScan(
  scanId: string,
  domain: string,
  scans: ScanStore,
  auditDomain: FastifyInstance["auditDomain"],
): Promise<void> {
  await scans.markRunning(scanId);

  // One trace id links the pre-queue guard, each redirect hop and the DNS
  // re-validation in crawler logs (Blueprint §21.1: every job carries trace_id).
  const traceId = generateTraceId();

  // The audit core (guard → normalize → fetch → parse → deterministic rules)
  // lives ONCE in audit/domain-audit.ts and is shared with the tenant project
  // crawl path (P-GAP-04). This worker only persists the result.
  const audit = await auditDomain(domain, traceId);

  await scans.updateResult(
    scanId,
    audit.status,
    audit.findings,
    audit.evidence,
    audit.errorMessage,
  );

  logger.info("Scan completed", {
    jobType: "public-scan",
    traceId,
    domain,
    status: audit.status,
    findingCount: audit.findings.length,
    httpStatus: audit.httpStatus,
  });
}
