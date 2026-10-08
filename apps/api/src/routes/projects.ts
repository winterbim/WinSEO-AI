import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logger, generateTraceId } from "@serpvera/telemetry";
import { guardUrl, normalizeAuditTarget, gateForRule } from "@serpvera/crawler";
import { requireAuth } from "../auth/session.ts";

const PROJECT_CRAWL_RATE_LIMIT_PER_HOUR = Math.max(
  1,
  Number.parseInt(process.env.PROJECT_CRAWL_RATE_LIMIT_PER_HOUR ?? "10", 10) || 10,
);

export function projectRoutes(app: FastifyInstance) {
  // POST /v1/projects — tenant-scoped; withTenant() sets the org GUC so RLS
  // WITH CHECK blocks inserting into another organization.
  app.post("/", async (request, reply) => {
    try {
      requireAuth(request, reply);
    } catch {
      return;
    }

    const schema = z.object({
      organizationId: z.uuid(),
      primaryDomain: z.string().min(1).max(253),
      name: z.string().min(1).max(100).optional(),
    });

    const body = schema.parse(request.body);

    let primaryDomain: string;
    try {
      const target = normalizeAuditTarget(body.primaryDomain);
      const parsed = new URL(target.normalized);
      if (parsed.pathname !== "/" || parsed.search) {
        throw new Error("Project sites must be an origin, not a page URL.");
      }
      guardUrl(parsed.origin);
      primaryDomain = parsed.host;
    } catch {
      return reply.status(400).send({
        error: {
          code: "INVALID_DOMAIN",
          message: "Enter a public HTTP(S) site domain without a page path or query string.",
        },
      });
    }

    // Verify membership BEFORE attempting creation (application-layer authz in
    // front of DB-layer RLS — defense in depth).
    const org = await app.stores.orgs.getForRequester(request.session.userId, body.organizationId);
    if (!org) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Organization not found." },
      });
    }

    const idempotencyHeader = request.headers["idempotency-key"];
    if (idempotencyHeader !== undefined && typeof idempotencyHeader !== "string") {
      return reply.status(400).send({
        error: { code: "INVALID_IDEMPOTENCY_KEY", message: "Idempotency-Key must be a UUID." },
      });
    }
    const parsedIdempotencyKey =
      idempotencyHeader === undefined ? null : z.uuid().safeParse(idempotencyHeader);
    if (parsedIdempotencyKey && !parsedIdempotencyKey.success) {
      return reply.status(400).send({
        error: { code: "INVALID_IDEMPOTENCY_KEY", message: "Idempotency-Key must be a UUID." },
      });
    }

    const name = body.name ?? primaryDomain;
    if (parsedIdempotencyKey?.success) {
      const result = await app.stores.projects.createProjectWithIdempotencyKey(
        body.organizationId,
        name,
        primaryDomain,
        parsedIdempotencyKey.data.toLowerCase(),
      );
      if (result.kind === "conflict") {
        return reply.status(409).send({
          error: {
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "This idempotency key was already used for a different project.",
          },
        });
      }
      return reply.status(result.kind === "created" ? 201 : 200).send({ project: result.project });
    }

    const project = await app.stores.projects.createProject(
      body.organizationId,
      name,
      primaryDomain,
    );

    return reply.status(201).send({ project });
  });

  // GET /v1/projects/:projectId — requires active org selection in the session.
  // The store runs the lookup under the tenant GUC, so a foreign-tenant project
  // id returns 404 rather than its data (DB-03c behaviour at the API layer).
  app.get("/:projectId", async (request, reply) => {
    try {
      requireAuth(request, reply);
    } catch {
      return;
    }

    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "INVALID_ID", message: "Project id must be a UUID." },
      });
    }

    if (!request.session.organizationId) {
      return reply.status(400).send({
        error: {
          code: "NO_ACTIVE_ORGANIZATION",
          message: "Select an organization first.",
        },
      });
    }

    // Membership check before tenant-scoped read.
    const org = await app.stores.orgs.getForRequester(
      request.session.userId,
      request.session.organizationId,
    );
    if (!org) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Organization not found." },
      });
    }

    const project = await app.stores.projects.getProject(
      request.session.organizationId,
      params.data.projectId,
    );
    if (!project) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Project not found." },
      });
    }

    return reply.send({ project });
  });

  // POST /v1/projects/:projectId/crawl-runs — authenticated, tenant-scoped
  // (P-GAP-04). Runs the SAME audit core as the public scan (single engine),
  // then persists findings + evidence as first-class rows under RLS so the
  // Evidence Ledger is queryable. Anonymous public scans intentionally stay
  // bounded JSONB — they have no tenant and live only for their sample.
  app.post("/:projectId/crawl-runs", async (request, reply) => {
    try {
      requireAuth(request, reply);
    } catch {
      return;
    }

    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "INVALID_ID", message: "Project id must be a UUID." },
      });
    }

    const organizationId = request.session.organizationId;
    if (!organizationId) {
      return reply.status(400).send({
        error: {
          code: "NO_ACTIVE_ORGANIZATION",
          message: "Select an organization first.",
        },
      });
    }

    // Membership check (application authz) before any tenant work.
    const org = await app.stores.orgs.getForRequester(request.session.userId, organizationId);
    if (!org) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Organization not found." },
      });
    }

    const project = await app.stores.projects.getProject(organizationId, params.data.projectId);
    if (!project) {
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Project not found." } });
    }

    // ─── SSRF pre-queue guard (same rule as the public scan) ───
    let crawlTarget: string;
    try {
      crawlTarget = normalizeAuditTarget(project.primaryDomain).normalized;
      guardUrl(crawlTarget);
    } catch (ssrfErr) {
      logger.warn("Project crawl rejected by SSRF guard", {
        organizationId,
        projectId: project.id,
        error: (ssrfErr as Error).message,
      });
      return reply.status(400).send({
        error: {
          code: "SSRF_BLOCKED",
          message: "Domain rejected by security policy: only public internet targets are allowed.",
        },
      });
    }

    const quota = await app.stores.rateLimits.hit(
      organizationId,
      PROJECT_CRAWL_RATE_LIMIT_PER_HOUR,
      "project-crawl-org",
    );
    if (!quota.allowed) {
      reply.header("retry-after", String(quota.retryAfterSeconds));
      return reply.status(429).send({
        error: {
          code: "CRAWL_RATE_LIMITED",
          message: `This organization has reached its crawl limit of ${PROJECT_CRAWL_RATE_LIMIT_PER_HOUR} runs per hour.`,
        },
      });
    }

    let run: Awaited<ReturnType<typeof app.stores.crawl.createCrawlRun>>;
    try {
      run = await app.stores.crawl.createCrawlRun(organizationId, project.id, "HTTP_FAST");
    } catch (error) {
      await app.stores.rateLimits
        .release(organizationId, PROJECT_CRAWL_RATE_LIMIT_PER_HOUR, "project-crawl-org")
        .catch(() => {
          logger.error("Failed to release quota after crawl admission error", {
            organizationId,
            projectId: project.id,
            error: "quota_release_failed",
          });
        });
      throw error;
    }
    if (!run) {
      await app.stores.rateLimits
        .release(organizationId, PROJECT_CRAWL_RATE_LIMIT_PER_HOUR, "project-crawl-org")
        .catch(() => {
          logger.error("Failed to release quota after rejected crawl admission", {
            organizationId,
            projectId: project.id,
            error: "quota_release_failed",
          });
        });
      return reply.status(409).send({
        error: {
          code: "CRAWL_ALREADY_RUNNING",
          message: "A crawl is already running for this project.",
        },
      });
    }

    // Fire-and-forget worker: audit the domain, then persist rows tenant-scoped.
    void (async () => {
      const traceId = generateTraceId();
      let observedPagesCrawled = 0;
      let observedPagesFailed = 0;
      let observedPageLimit = 50;
      let observedStopReason: string | null = null;
      let observedTemplateGroups: Awaited<ReturnType<typeof app.auditSite>>["templateGroups"] = [];
      try {
        const audit = await app.auditSite(crawlTarget, traceId, { maxPages: 50 });
        observedPagesCrawled = audit.pagesCrawled;
        observedPagesFailed = audit.pagesFailed;
        observedPageLimit = audit.pageLimit;
        observedStopReason = audit.stopReason ?? null;
        observedTemplateGroups = audit.templateGroups;

        const findingIdsByUrl = new Map<string, string[]>();
        for (const f of audit.findings) {
          const created = await app.stores.crawl.addFinding(organizationId, project.id, {
            ruleId: f.ruleId,
            ruleVersion: f.ruleVersion,
            title: f.title,
            epistemicClass: f.epistemicClass,
            severity: f.severity,
            explanation: f.explanation,
            recommendation: f.recommendation,
            // PHASE-3-UI: scope + declared gate (rule contract, Blueprint §13.2).
            affectedUrls: f.affectedUrls,
            verificationGate: gateForRule(f.ruleId),
            crawlRunId: run.id,
          });
          for (const url of f.affectedUrls) {
            const findingIds = findingIdsByUrl.get(url) ?? [];
            findingIds.push(created.id);
            findingIdsByUrl.set(url, findingIds);
          }
          // Workflow entry (Blueprint §17.1): first state is DETECTED.
          await app.stores.crawl.createDetectedAction(organizationId, project.id, created.id);
        }
        for (const e of audit.evidence) {
          const created = await app.stores.crawl.addEvidence(organizationId, project.id, {
            kind: e.kind,
            sourceRef: e.sourceRef,
            contentHash: e.contentHash,
            objectKey: `${organizationId}/${project.id}/${e.kind}/${e.contentHash}`,
            metadata: {
              finalUrl: e.finalUrl,
              httpStatus: e.httpStatus,
              contentLength: e.contentLength,
              summary: e.summary,
              // Render-escalation provenance when present (reasons, divergences,
              // rendered DOM hash + excerpt) — see domain-audit RenderMeta.
              ...e.metadata,
            },
            crawlRunId: run.id,
          });
          // Keep evidence attached to findings from the same requested/final URL.
          const relatedIds = new Set([
            ...(findingIdsByUrl.get(e.sourceRef) ?? []),
            ...(findingIdsByUrl.get(e.finalUrl) ?? []),
          ]);
          for (const findingId of relatedIds) {
            await app.stores.crawl.linkFindingEvidence(organizationId, findingId, created.id);
          }
        }
        await app.stores.crawl.finishCrawlRun(
          organizationId,
          run.id,
          audit.status,
          audit.pagesCrawled,
          audit.pagesFailed,
          audit.pageLimit,
          audit.stopReason,
          audit.templateGroups,
        );
        logger.info("Project crawl completed", {
          jobType: "project-crawl",
          traceId,
          organizationId,
          projectId: project.id,
          status: audit.status,
          pagesCrawled: audit.pagesCrawled,
          pagesFailed: audit.pagesFailed,
          pageLimit: audit.pageLimit,
          stopReason: audit.stopReason,
          findingCount: audit.findings.length,
        });
      } catch (err) {
        logger.error("Project crawl worker failed", {
          traceId,
          organizationId,
          projectId: project.id,
          error: (err as Error).message,
        });
        await app.stores.crawl
          .finishCrawlRun(
            organizationId,
            run.id,
            "failed",
            observedPagesCrawled,
            observedPagesFailed,
            observedPageLimit,
            observedStopReason,
            observedTemplateGroups,
          )
          .catch(() => undefined);
      }
    })();

    return reply.status(201).send({
      crawlRun: { id: run.id, projectId: project.id, status: "running" },
    });
  });

  // GET /v1/projects/:projectId/findings — tenant-scoped Evidence Ledger query.
  // RLS guarantees a foreign-tenant project id yields zero rows (404 below via
  // the project existence check, which is itself tenant-filtered).
  app.get("/:projectId/findings", async (request, reply) => {
    try {
      requireAuth(request, reply);
    } catch {
      return;
    }

    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "INVALID_ID", message: "Project id must be a UUID." },
      });
    }

    const organizationId = request.session.organizationId;
    if (!organizationId) {
      return reply.status(400).send({
        error: {
          code: "NO_ACTIVE_ORGANIZATION",
          message: "Select an organization first.",
        },
      });
    }

    const project = await app.stores.projects.getProject(organizationId, params.data.projectId);
    if (!project) {
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Project not found." } });
    }

    const findings = await app.stores.crawl.listFindings(organizationId, project.id);
    return reply.send({ findings });
  });
}
