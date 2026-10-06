import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { hasPermission } from "@serpvera/authz";
import { ActionMutationError } from "@serpvera/db";
import type { Permission } from "@serpvera/contracts";
import { requireAuth } from "../auth/session.ts";

const states = [
  "DETECTED",
  "EVIDENCED",
  "PROPOSED",
  "APPROVED",
  "REPORTED_MANUALLY",
  "MEASURING",
  "VERIFIED",
  "REJECTED",
  "INCONCLUSIVE",
  "CLOSED",
] as const;

const severities = ["critical", "high", "medium", "low", "info"] as const;

function activeOrg(request: FastifyRequest, reply: FastifyReply): string | null {
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

function requireActionPermission(
  request: FastifyRequest,
  reply: FastifyReply,
  permission: Permission,
): boolean {
  const role = request.session?.role;
  if (!role || !hasPermission(role, permission)) {
    void reply.status(403).send({
      error: { code: "FORBIDDEN", message: `Role cannot perform ${permission}.` },
    });
    return false;
  }
  return true;
}

const transitionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  toState: z.union([z.enum(states), z.literal("EVALUATE"), z.literal("REJECT_PROPOSAL")]),
  recommendation: z
    .object({
      summary: z.string().trim().min(1).max(4_000),
      rationale: z.string().trim().max(8_000).optional(),
      verificationGate: z.object({
        type: z.string().trim().min(1).max(100),
        spec: z.record(z.string(), z.unknown()).optional(),
      }),
    })
    .optional(),
  approvalDecision: z.enum(["APPROVE", "REJECT"]).optional(),
  implementation: z
    .object({
      whatChanged: z.string().trim().min(1).max(12_000),
      how: z.string().trim().min(1).max(4_000),
      references: z.array(z.string().trim().min(1).max(2_000)).max(50).optional(),
    })
    .optional(),
  rollback: z
    .object({
      strategy: z.string().trim().min(1).max(8_000),
      trigger: z.string().trim().max(4_000).optional(),
      references: z.array(z.string().trim().min(1).max(2_000)).max(50).optional(),
    })
    .optional(),
  baselineSnapshot: z.record(z.string(), z.unknown()).optional(),
  comparisonWindow: z
    .object({ startsAt: z.iso.datetime(), endsAt: z.iso.datetime() })
    .optional(),
  note: z.string().trim().max(4_000).optional(),
});

export function projectActionRoutes(app: FastifyInstance) {
  app.get("/:projectId/actions", async (request, reply) => {
    const organizationId = activeOrg(request, reply);
    if (!organizationId) return;
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    const query = z
      .object({ status: z.enum(states).optional(), severity: z.enum(severities).optional() })
      .safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.status(400).send({
        error: { code: "INVALID_FILTER", message: "Invalid project id or action filter." },
      });
    }
    const project = await app.stores.projects.getProject(organizationId, params.data.projectId);
    if (!project) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Project not found." },
      });
    }
    const actions = await app.stores.actions.listActions(organizationId, project.id, {
      state: query.data.status,
      severity: query.data.severity,
    });
    return reply.send({ actions });
  });
}

export function actionRoutes(app: FastifyInstance) {
  app.get("/:actionId", async (request, reply) => {
    const organizationId = activeOrg(request, reply);
    if (!organizationId) return;
    const params = z.object({ actionId: z.uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "INVALID_ID", message: "Action id must be a UUID." },
      });
    }
    const action = await app.stores.actions.getAction(organizationId, params.data.actionId);
    if (!action) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Action not found." },
      });
    }
    return reply.send({ action });
  });

  app.post("/:actionId/transitions", async (request, reply) => {
    const organizationId = activeOrg(request, reply);
    if (!organizationId) return;
    const params = z.object({ actionId: z.uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "INVALID_ID", message: "Action id must be a UUID." },
      });
    }
    const body = transitionSchema.parse(request.body);
    const permission: Permission =
      body.toState === "REPORTED_MANUALLY" ? "production.write" : "action.approve";
    if (!requireActionPermission(request, reply, permission)) return;
    const session = request.session;
    if (!session) return;

    try {
      const action = await app.stores.actions.transitionAction(
        organizationId,
        params.data.actionId,
        { userId: session.userId, email: session.email },
        {
          ...body,
          toState: body.toState,
        },
      );
      return await reply.send({ action });
    } catch (error) {
      if (!(error instanceof ActionMutationError)) throw error;
      if (error.code === "ACTION_NOT_FOUND") {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "Action not found." },
        });
      }
      return reply.status(409).send({
        error: { code: error.code, message: error.message },
      });
    }
  });
}
