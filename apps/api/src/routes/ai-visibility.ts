import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AI_VISIBILITY_MAX_CSV_BYTES, parseAiVisibilityCsv } from "@serpvera/contracts";
import { AiVisibilityDuplicateImportError, AiVisibilityPermissionError } from "@serpvera/db";
import { z } from "zod";
import { activeOrg, requirePermission } from "../auth/request-context.ts";
import type { StoredAiVisibilityImport } from "../stores/types.ts";

const importBodySchema = z
  .object({
    csvText: z.string().min(1),
    csvSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const importListQuerySchema = z
  .object({
    limit: z.string().regex(/^\d+$/).optional(),
    offset: z.string().regex(/^\d+$/).optional(),
    compare: z.string().max(200).optional(),
    includeStats: z.enum(["true", "false"]).optional(),
  })
  .strict();

const DATA_AVAILABILITY = {
  source: "USER_SUPPLIED",
  epistemicClass: "DOCUMENTED",
  unverified_by_provider: true,
  promptPanelCompleteness: "UNKNOWN",
  basis: "persisted imported captures only",
} as const;

interface AiVisibilityImportResponse {
  id: string;
  projectId: string;
  uploadedBy: string | null;
  csvSha256: string;
  hashVerified: true;
  rowCount: number;
  provenance: "USER_SUPPLIED";
  epistemicClass: "DOCUMENTED";
  unverified_by_provider: true;
  createdAt: string;
}

async function resolveProject(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
): Promise<{ organizationId: string; projectId: string; userId: string } | null> {
  const organizationId = activeOrg(request, reply);
  if (!organizationId) return null;
  const userId = request.session?.userId;
  if (!userId) return null;
  const membership = await app.stores.orgs.getForRequester(userId, organizationId);
  if (!membership) {
    void reply.status(404).send({
      error: { code: "NOT_FOUND", message: "Project not found." },
    });
    return null;
  }
  const project = await app.stores.projects.getProject(organizationId, projectId);
  if (!project) {
    void reply.status(404).send({
      error: { code: "NOT_FOUND", message: "Project not found." },
    });
    return null;
  }
  return { organizationId, projectId: project.id, userId };
}

function toImportResponse(row: StoredAiVisibilityImport): AiVisibilityImportResponse {
  return {
    id: row.id,
    projectId: row.projectId,
    uploadedBy: row.uploadedBy,
    csvSha256: row.csvSha256,
    hashVerified: true,
    rowCount: row.rowCount,
    provenance: row.provenance,
    epistemicClass: row.epistemicClass,
    unverified_by_provider: row.unverifiedByProvider,
    createdAt: row.createdAt,
  };
}

export function aiVisibilityRoutes(app: FastifyInstance) {
  app.post(
    "/:projectId/ai-visibility/imports",
    { bodyLimit: 3 * 1024 * 1024 },
    async (request, reply) => {
      const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "INVALID_ID", message: "Project id must be a UUID." },
        });
      }
      const ctx = await resolveProject(app, request, reply, params.data.projectId);
      if (!ctx) return;
      const currentRole = await app.stores.orgs.getRoleForUser(ctx.userId, ctx.organizationId);
      if (!requirePermission(request, reply, "evidence.write", currentRole)) return;

      const parsed = importBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: "INVALID_IMPORT",
            message: "csvText and a lowercase SHA-256 csvSha256 are required.",
          },
        });
      }
      if (Buffer.byteLength(parsed.data.csvText, "utf8") > AI_VISIBILITY_MAX_CSV_BYTES) {
        return reply.status(413).send({
          error: { code: "CSV_TOO_LARGE", message: "CSV exceeds the 1 MiB import limit." },
        });
      }

      const actualHash = createHash("sha256").update(parsed.data.csvText, "utf8").digest("hex");
      if (actualHash !== parsed.data.csvSha256) {
        return reply.status(400).send({
          error: {
            code: "CSV_HASH_MISMATCH",
            message: "csvSha256 does not match the submitted CSV text.",
          },
        });
      }

      let captures;
      try {
        captures = parseAiVisibilityCsv(parsed.data.csvText);
      } catch (err) {
        return reply.status(400).send({
          error: {
            code: "INVALID_CSV",
            message: err instanceof Error ? err.message : "CSV could not be parsed.",
          },
        });
      }

      try {
        const imported = await app.stores.aiVisibility.createImport({
          ...ctx,
          uploadedBy: ctx.userId,
          csvSha256: actualHash,
          captures,
        });
        const stats = await app.stores.aiVisibility.listStats(
          ctx.organizationId,
          ctx.projectId,
          imported.id,
        );
        return await reply.status(201).send({
          import: toImportResponse(imported),
          stats,
          dataAvailability: DATA_AVAILABILITY,
        });
      } catch (err) {
        if (err instanceof AiVisibilityPermissionError) {
          return reply.status(403).send({
            error: { code: "FORBIDDEN", message: "Role cannot perform evidence.write." },
          });
        }
        if (err instanceof AiVisibilityDuplicateImportError) {
          return reply.status(409).send({
            error: {
              code: "AI_VISIBILITY_CSV_ALREADY_IMPORTED",
              message: "This exact CSV has already been imported for this project.",
            },
          });
        }
        throw err;
      }
    },
  );

  app.get("/:projectId/ai-visibility/imports", async (request, reply) => {
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "INVALID_ID", message: "Project id must be a UUID." },
      });
    }
    const ctx = await resolveProject(app, request, reply, params.data.projectId);
    if (!ctx) return;
    const query = importListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({
        error: { code: "INVALID_QUERY", message: "limit and offset must be whole numbers." },
      });
    }
    if (query.data.compare) {
      if (query.data.includeStats === "true") {
        return reply.status(400).send({
          error: {
            code: "INVALID_QUERY",
            message: "includeStats cannot be combined with compare.",
          },
        });
      }
      const compareIds = query.data.compare.split(",");
      if (
        compareIds.length < 2 ||
        compareIds.length > 5 ||
        new Set(compareIds).size !== compareIds.length ||
        compareIds.some((id) => !z.uuid().safeParse(id).success)
      ) {
        return reply.status(400).send({
          error: {
            code: "INVALID_COMPARISON",
            message: "compare must contain 2–5 distinct import UUIDs from this project.",
          },
        });
      }
      const comparisonResults = await Promise.all(
        compareIds.map(async (importId) => {
          const imported = await app.stores.aiVisibility.getImport(
            ctx.organizationId,
            ctx.projectId,
            importId,
          );
          if (!imported) return null;
          const stats = await app.stores.aiVisibility.listStats(
            ctx.organizationId,
            ctx.projectId,
            imported.id,
          );
          return { import: toImportResponse(imported), stats };
        }),
      );
      if (comparisonResults.some((result) => result === null)) {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "One or more AI visibility imports were not found.",
          },
        });
      }
      const comparisons = comparisonResults.filter(
        (result): result is NonNullable<typeof result> => result !== null,
      );
      comparisons.sort((a, b) => {
        return (
          a.import.createdAt.localeCompare(b.import.createdAt) ||
          a.import.id.localeCompare(b.import.id)
        );
      });
      return reply.send({ comparisons, dataAvailability: DATA_AVAILABILITY });
    }
    const includeStats = query.data.includeStats === "true";
    const limit = Number(query.data.limit ?? (includeStats ? "5" : "50"));
    const offset = Number(query.data.offset ?? "0");
    if (limit < 1 || limit > (includeStats ? 5 : 100) || offset > 10_000) {
      return reply.status(400).send({
        error: {
          code: "INVALID_QUERY",
          message: includeStats
            ? "Use limit 1–5 when includeStats=true and offset 0–10000."
            : "Use limit 1–100 and offset 0–10000.",
        },
      });
    }
    const imports = await app.stores.aiVisibility.listImports(
      ctx.organizationId,
      ctx.projectId,
      limit,
      offset,
    );
    const reportImports = includeStats
      ? await Promise.all(
          imports.map(async (imported) => ({
            ...toImportResponse(imported),
            stats: await app.stores.aiVisibility.listStats(
              ctx.organizationId,
              ctx.projectId,
              imported.id,
            ),
          })),
        )
      : imports.map(toImportResponse);
    return reply.send({
      imports: reportImports,
      dataAvailability: DATA_AVAILABILITY,
    });
  });

  app.get("/:projectId/ai-visibility/imports/:importId", async (request, reply) => {
    const params = z.object({ projectId: z.uuid(), importId: z.uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "INVALID_ID", message: "Project and import ids must be UUIDs." },
      });
    }
    const ctx = await resolveProject(app, request, reply, params.data.projectId);
    if (!ctx) return;
    const imported = await app.stores.aiVisibility.getImport(
      ctx.organizationId,
      ctx.projectId,
      params.data.importId,
    );
    if (!imported) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "AI visibility import not found." },
      });
    }
    const [captures, stats] = await Promise.all([
      app.stores.aiVisibility.listCaptures(ctx.organizationId, ctx.projectId, imported.id),
      app.stores.aiVisibility.listStats(ctx.organizationId, ctx.projectId, imported.id),
    ]);
    return reply.send({
      import: toImportResponse(imported),
      captures,
      stats,
      dataAvailability: DATA_AVAILABILITY,
    });
  });
}
