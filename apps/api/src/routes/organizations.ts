import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logger } from "@serpvera/telemetry";
import { requireAuth } from "../auth/session.ts";
import { DuplicateSlugError } from "../stores/types.ts";

export function orgRoutes(app: FastifyInstance) {
  // GET /v1/organizations — orgs the caller is an active member of.
  // Used by the workspace UI to (re-)activate tenant context on a fresh
  // session; membership is derived server-side, never client-asserted.
  app.get("/", async (request, reply) => {
    try {
      requireAuth(request, reply);
    } catch {
      return;
    }
    const organizations = await app.stores.orgs.listForUser(request.session.userId);
    return reply.send({ organizations });
  });

  // POST /v1/organizations — creates org + OWNER membership atomically
  app.post("/", async (request, reply) => {
    try {
      requireAuth(request, reply);
    } catch {
      return;
    }

    const schema = z.object({
      name: z.string().min(1).max(100),
      slug: z
        .string()
        .min(1)
        .max(50)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase alphanumeric with hyphens")
        .optional(),
    });

    const body = schema.parse(request.body);
    const slug =
      body.slug ??
      body.name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

    if (!slug) {
      return reply.status(400).send({
        error: { code: "INVALID_SLUG", message: "Could not derive a slug from the name." },
      });
    }

    try {
      const org = await app.stores.orgs.createOrganization(
        request.session.userId,
        body.name,
        slug,
      );

      logger.info("Organization created", {
        organizationId: org.id,
        userId: request.session.userId,
      });

      return await reply.status(201).send({ organization: org });
    } catch (err) {
      if (err instanceof DuplicateSlugError) {
        return reply.status(409).send({
          error: { code: "SLUG_EXISTS", message: err.message },
        });
      }
      throw err;
    }
  });

  // GET /v1/organizations/:orgId — membership-gated.
  // Uniform 404 for both "does not exist" and "not a member": a 403 would leak
  // the existence of another tenant's org (existence oracle).
  app.get("/:orgId", async (request, reply) => {
    try {
      requireAuth(request, reply);
    } catch {
      return;
    }

    const params = z.object({ orgId: z.uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "INVALID_ID", message: "Organization id must be a UUID." },
      });
    }

    const org = await app.stores.orgs.getForRequester(
      request.session.userId,
      params.data.orgId,
    );
    if (!org) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Organization not found." },
      });
    }

    return reply.send({ organization: org });
  });
}
