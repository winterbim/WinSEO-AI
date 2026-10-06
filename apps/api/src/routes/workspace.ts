// ─── Workspace read endpoints (PHASE-3-UI) ───
// Authenticated, tenant-scoped reads backing the Evidence Ledger dashboard.
// Every store call carries the session's organizationId; the DB layer runs it
// under withTenant() (SET ROLE serpvera_app + org GUC), so RLS is the actual
// boundary — these handlers only decide HTTP shape (401/400/404).

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/session.ts";

function orgOf(request: FastifyRequest, reply: Parameters<typeof requireAuth>[1]): string | null {
  try {
    requireAuth(request, reply);
  } catch {
    return null;
  }
  if (!request.session.organizationId) {
    void reply.status(400).send({
      error: { code: "NO_ACTIVE_ORGANIZATION", message: "Select an organization first." },
    });
    return null;
  }
  return request.session.organizationId;
}

export function workspaceRoutes(app: FastifyInstance) {
  // GET /v1/projects — projects of the active organization.
  app.get("/", async (request, reply) => {
    const organizationId = orgOf(request, reply);
    if (!organizationId) return;

    const projects = await app.stores.projects.listProjects(organizationId);
    return reply.send({ projects });
  });

  // Shared project resolution: auth + active org + tenant-scoped existence.
  async function resolveProject(
    request: FastifyRequest,
    reply: Parameters<typeof requireAuth>[1],
    projectId: string,
  ): Promise<{ organizationId: string; projectId: string } | null> {
    const organizationId = orgOf(request, reply);
    if (!organizationId) return null;
    const project = await app.stores.projects.getProject(organizationId, projectId);
    if (!project) {
      void reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Project not found." },
      });
      return null;
    }
    return { organizationId, projectId: project.id };
  }

  // GET /v1/projects/:projectId/crawl-runs — crawl history (newest first).
  app.get("/:projectId/crawl-runs", async (request, reply) => {
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "INVALID_ID", message: "Project id must be a UUID." },
      });
    }
    const ctx = await resolveProject(request, reply, params.data.projectId);
    if (!ctx) return;

    const crawlRuns = await app.stores.crawl.listCrawlRuns(ctx.organizationId, ctx.projectId);
    return reply.send({ crawlRuns });
  });

  // GET /v1/projects/:projectId/evidence — evidence items (drawer listing).
  app.get("/:projectId/evidence", async (request, reply) => {
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "INVALID_ID", message: "Project id must be a UUID." },
      });
    }
    const ctx = await resolveProject(request, reply, params.data.projectId);
    if (!ctx) return;

    const evidence = await app.stores.crawl.listEvidence(ctx.organizationId, ctx.projectId);
    return reply.send({ evidence });
  });

  // GET /v1/projects/:projectId/overview — the dashboard's four questions,
  // answered ONLY from persisted rows (no synthetic score, no invented metrics).
  app.get("/:projectId/overview", async (request, reply) => {
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "INVALID_ID", message: "Project id must be a UUID." },
      });
    }
    const ctx = await resolveProject(request, reply, params.data.projectId);
    if (!ctx) return;

    const project = await app.stores.projects.getProject(ctx.organizationId, ctx.projectId);
    const findings = await app.stores.crawl.listFindings(ctx.organizationId, ctx.projectId);
    const evidence = await app.stores.crawl.listEvidence(ctx.organizationId, ctx.projectId);
    const crawlRuns = await app.stores.crawl.listCrawlRuns(ctx.organizationId, ctx.projectId);
    const actions = await app.stores.actions.listActions(ctx.organizationId, ctx.projectId);

    const bySeverity: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const f of findings) {
      bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
    }

    return reply.send({
      project,
      findings: {
        total: findings.length,
        bySeverity,
        byStatus,
        // Newest evidence-backed finding: drives "what changed".
        latest: findings[0]
          ? {
              id: findings[0].id,
              title: findings[0].title,
              severity: findings[0].severity,
              ruleId: findings[0].ruleId,
              firstSeenAt: findings[0].firstSeenAt,
            }
          : null,
      },
      evidence: { total: evidence.length },
      crawls: { total: crawlRuns.length, latest: crawlRuns[0] ?? null },
      // Honest emptiness: no intervention has been recorded because none has
      // been implemented yet. Never rendered as a fake "100% healthy".
      interventions: {
        verified: actions.filter(
          (action) =>
            action.state === "VERIFIED" ||
            (action.state === "CLOSED" && action.verification?.verdict === "PASS"),
        ).length,
        pending: actions.filter(
          (action) => !["VERIFIED", "REJECTED", "CLOSED"].includes(action.state),
        ).length,
        note: actions.some(
          (action) => action.state === "VERIFIED" || action.verification?.verdict === "PASS",
        )
          ? "Verified interventions are backed by their declared gates."
          : "No intervention verified yet.",
      },
      dataFreshness: new Date().toISOString(),
      methodVersion: "0.1.0",
    });
  });
}

export function findingRoutes(app: FastifyInstance) {
  // GET /v1/findings/:findingId — finding detail incl. linked evidence.
  app.get("/:findingId", async (request, reply) => {
    try {
      requireAuth(request, reply);
    } catch {
      return;
    }
    if (!request.session.organizationId) {
      return reply.status(400).send({
        error: { code: "NO_ACTIVE_ORGANIZATION", message: "Select an organization first." },
      });
    }

    const params = z.object({ findingId: z.uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "INVALID_ID", message: "Finding id must be a UUID." },
      });
    }

    const finding = await app.stores.crawl.getFinding(
      request.session.organizationId,
      params.data.findingId,
    );
    if (!finding) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Finding not found." },
      });
    }

    return reply.send({ finding });
  });
}
