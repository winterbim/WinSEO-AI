import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logger, generateTraceId } from "@serpvera/telemetry";
import { guardUrl, normalizeUrl, gateForRule } from "@serpvera/crawler";
import { requireAuth } from "../auth/session.ts";

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

    // Verify membership BEFORE attempting creation (application-layer authz in
    // front of DB-layer RLS — defense in depth).
    const org = await app.stores.orgs.getForRequester(request.session.userId, body.organizationId);
    if (!org) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Organization not found." },
      });
    }

    const project = await app.stores.projects.createProject(
      body.organizationId,
      body.name ?? body.primaryDomain,
      body.primaryDomain,
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
    try {
      guardUrl(`https://${project.primaryDomain}/`);
      normalizeUrl(`https://${project.primaryDomain}/`);
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

    const run = await app.stores.crawl.createCrawlRun(organizationId, project.id, "HTTP_FAST");

    // Fire-and-forget worker: audit the domain, then persist rows tenant-scoped.
    void (async () => {
      const traceId = generateTraceId();
      try {
        const audit = await app.auditDomain(project.primaryDomain, traceId);

        const findingIds: string[] = [];
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
          findingIds.push(created.id);
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
          // Link this evidence to every finding of the run (supports).
          for (const findingId of findingIds) {
            await app.stores.crawl.linkFindingEvidence(organizationId, findingId, created.id);
          }
        }
        await app.stores.crawl.finishCrawlRun(
          organizationId,
          run.id,
          audit.status,
          audit.status === "completed" ? 1 : 0,
          audit.status === "failed" ? 1 : 0,
        );
        logger.info("Project crawl completed", {
          jobType: "project-crawl",
          traceId,
          organizationId,
          projectId: project.id,
          status: audit.status,
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
          .finishCrawlRun(organizationId, run.id, "failed", 0, 1)
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
