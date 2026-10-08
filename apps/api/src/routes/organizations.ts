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
    const autoSlug = body.slug === undefined;
    const slugBase =
      body.slug ??
      body.name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50)
        .replace(/-+$/g, "");

    if (!slugBase) {
      return reply.status(400).send({
        error: { code: "INVALID_SLUG", message: "Could not derive a slug from the name." },
      });
    }

    for (let attempt = 1; attempt <= 100; attempt += 1) {
      const suffix = attempt === 1 ? "" : `-${attempt}`;
      const slug = autoSlug
        ? `${slugBase.slice(0, 50 - suffix.length).replace(/-+$/g, "")}${suffix}`
        : slugBase;

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
          if (autoSlug && attempt < 100) continue;
          return reply.status(409).send({
            error: {
              code: autoSlug ? "SLUG_ALLOCATION_EXHAUSTED" : "SLUG_EXISTS",
              message: autoSlug
                ? "Could not allocate a unique workspace address. Please retry."
                : err.message,
            },
          });
        }
        throw err;
      }
    }

    return reply.status(409).send({
      error: {
        code: "SLUG_ALLOCATION_EXHAUSTED",
        message: "Could not allocate a unique workspace address. Please retry.",
      },
    });
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

    const org = await app.stores.orgs.getForRequester(request.session.userId, params.data.orgId);
    if (!org) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Organization not found." },
      });
    }

    return reply.send({ organization: org });
  });
}
