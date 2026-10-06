// ─── GSC routes: OAuth, property connections, Search Analytics ingestion ───
//
// Security posture enforced here:
//   • Mutations require `integration.manage`; reads require `project.read`.
//   • Every project-scoped route resolves the project inside the caller's
//     organization first — a foreign id is a 404, never a 403 oracle.
//   • Token material is never serialised: responses carry status, freshness
//     and Google property names only.
//   • Without Google client credentials the API answers GSC_NOT_CONFIGURED;
//     without a PostgreSQL store it answers GSC_STORE_UNAVAILABLE. Neither
//     path fabricates metrics.

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { loadConfig } from "@serpvera/config";
import { activeOrg, requirePermission } from "../auth/request-context.ts";
import { deriveGscKey, encryptSecret } from "../integrations/gsc/crypto.ts";
import { GscApiError, type GoogleTransport } from "../integrations/gsc/google-transport.ts";
import {
  buildAuthorizeUrl,
  createPkcePair,
  createStateToken,
  disconnectGoogle,
  getValidAccessToken,
  hashState,
  parseStateOrganization,
} from "../integrations/gsc/oauth.ts";
import { canRetryJob, deriveIncrementalWindow, runGscIngest } from "../integrations/gsc/ingest.ts";
import { GscCredentialsRequiredError } from "../integrations/gsc/types.ts";
import { GscAlreadyConnectedError } from "@serpvera/db";
import type { GscStore } from "../stores/types.ts";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const MAX_WINDOW_DAYS = 366;

const authorizeBody = z.object({ projectId: z.uuid() });
const callbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  error_description: z.string().optional(),
});
const connectBody = z.object({
  externalProperty: z
    .string()
    .trim()
    .min(3)
    .max(500)
    // Properties are either a URL (site scoping) or `sc-domain:` (domain scoping).
    .refine((v) => /^sc-domain:[a-z0-9.-]+$/i.test(v) || /^https?:\/\//i.test(v), {
      message: "expected an http(s) URL or sc-domain: property",
    }),
});
const syncBody = z
  .object({
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),
    connectionId: z.uuid(),
  })
  // Either both ends of an explicit window, or neither — an incremental sync
  // derives its window from the connection's last completed sync.
  .refine((v) => Boolean(v.startDate) === Boolean(v.endDate), {
    message: "provide both startDate and endDate, or neither (incremental)",
  });

interface WindowPair { startDate: string; endDate: string }

function windowError(window: WindowPair): string | null {
  const start = Date.parse(`${window.startDate}T00:00:00Z`);
  const end = Date.parse(`${window.endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "Malformed date.";
  if (end < start) return "endDate must not precede startDate.";
  if ((end - start) / 86_400_000 > MAX_WINDOW_DAYS) {
    return `Window exceeds the ${MAX_WINDOW_DAYS}-day limit; sync in smaller ranges.`;
  }
  const tomorrow = Date.now() + 86_400_000;
  if (end > tomorrow) return "endDate cannot be in the future.";
  return null;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

/** Map transport/domain failures onto the API's error contract. */
async function sendGscFailure(reply: FastifyReply, err: unknown): Promise<FastifyReply> {
  if (err instanceof GscCredentialsRequiredError) {
    return await sendError(
      reply,
      409,
      "GSC_NOT_CONNECTED",
      "Connect a Google Search Console property before requesting live data.",
    );
  }
  if (err instanceof GscApiError) {
    const status = err.code === "UNAUTHORIZED" ? 401 : err.code === "NETWORK" ? 502 : 502;
    return await sendError(reply, status, `GSC_${err.code}`, err.message);
  }
  throw err;
}

export function gscRoutes(app: FastifyInstance) {
  const config = loadConfig();
  const key = deriveGscKey(config.gscTokenKey);
  const transport: GoogleTransport = app.gscTransport;

  const requireGscConfig = (reply: FastifyReply): typeof config.gsc | null => {
    if (!config.gsc) {
      void sendError(
        reply,
        503,
        "GSC_NOT_CONFIGURED",
        "Google OAuth client credentials are not configured for this deployment.",
      );
      return null;
    }
    return config.gsc;
  };

  const requireStore = (reply: FastifyReply): GscStore | null => {
    if (!app.stores.gsc) {
      void sendError(
        reply,
        501,
        "GSC_STORE_UNAVAILABLE",
        "Google credentials are persisted encrypted in PostgreSQL; the active store driver cannot hold them.",
      );
      return null;
    }
    return app.stores.gsc;
  };

  /** Resolve a project inside the caller's tenant, else 404 (no leak). */
  const requireProject = async (
    organizationId: string,
    projectId: string,
    reply: FastifyReply,
  ): Promise<{ id: string } | null> => {
    const project = await app.stores.projects.getProject(organizationId, projectId);
    if (!project) {
      sendError(reply, 404, "NOT_FOUND", "Project not found.");
      return null;
    }
    return project;
  };

  // ─── 1. OAuth authorization ───
  app.post("/gsc/oauth/authorize", async (request, reply) => {
    const organizationId = activeOrg(request, reply);
    if (!organizationId) return;
    if (!requirePermission(request, reply, "integration.manage")) return;
    const gscCfg = requireGscConfig(reply); if (!gscCfg) return;
    const gsc = requireStore(reply); if (!gsc) return;

    const parsed = authorizeBody.safeParse(request.body);
    if (!parsed.success) {
      return await sendError(reply, 400, "VALIDATION_ERROR", "projectId must be a UUID.");
    }
    const project = await requireProject(organizationId, parsed.data.projectId, reply);
    if (!project) return;

    const { state, stateHash } = createStateToken(organizationId);
    const { codeVerifier, codeChallenge } = createPkcePair();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await gsc.createOauthState({
      organizationId,
      projectId: project.id,
      stateHash,
      codeVerifier,
      expiresAt,
    });

    const authorizeUrl = buildAuthorizeUrl({
      clientId: gscCfg.clientId,
      redirectUri: gscCfg.redirectUri,
      state,
      codeChallenge,
    });
    // Only the URL travels to the browser — never the verifier or the secret.
    return await reply.send({ authorizeUrl, expiresAt });
  });

  // ─── 2. OAuth callback (state + PKCE validated; no session required) ───
  app.get("/gsc/oauth/callback", async (request, reply) => {
    const gscCfg = requireGscConfig(reply); if (!gscCfg) return;
    const gsc = requireStore(reply); if (!gsc) return;

    const parsed = callbackQuery.safeParse(request.query);
    if (!parsed.success) {
      return await sendError(reply, 400, "INVALID_CALLBACK", "Malformed callback parameters.");
    }
    const { code, state, error } = parsed.data;
    if (error) {
      return await sendError(reply, 400, "GSC_ACCESS_DENIED", "Google did not grant access.");
    }
    if (!code || !state) {
      return await sendError(reply, 400, "INVALID_CALLBACK", "Missing authorization code or state.");
    }

    const organizationId = parseStateOrganization(state);
    if (!organizationId) {
      return await sendError(reply, 400, "INVALID_STATE", "OAuth state is not valid.");
    }
    const claimed = await gsc.consumeOauthState(organizationId, hashState(state));
    if (!claimed) {
      // Unknown, expired or already-used all collapse to one answer: a replayed
      // callback cannot learn whether a state ever existed.
      return await sendError(reply, 400, "INVALID_STATE", "OAuth state is not valid.");
    }

    try {
      const tokens = await transport.exchangeCode({
        code,
        codeVerifier: claimed.codeVerifier,
        redirectUri: gscCfg.redirectUri,
        clientId: gscCfg.clientId,
        clientSecret: gscCfg.clientSecret,
      });
      // Ciphertext only crosses this line — plaintext lives in memory below.
      const credentialId = await gsc.upsertCredential({
        organizationId,
        projectId: claimed.projectId,
        encryptedRefreshToken: encryptSecret(tokens.refreshToken ?? "", key),
        encryptedAccessToken: encryptSecret(tokens.accessToken, key),
        accessTokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
        scope: tokens.scope,
        googleSubject: tokens.tokenId ? subjectFromIdToken(tokens.tokenId) : null,
      });
      return await reply.send({
        status: "connected",
        projectId: claimed.projectId,
        credentialRef: credentialId,
        scope: tokens.scope,
      });
    } catch (err) {
      request.log.warn(
        { err: err instanceof GscApiError ? err.code : "UNKNOWN" },
        "GSC OAuth code exchange failed",
      );
      return await sendGscFailure(reply, err);
    }
  });

  // ─── 3. Property discovery ───
  app.get("/projects/:projectId/gsc/sites", async (request, reply) => {
    const organizationId = activeOrg(request, reply);
    if (!organizationId) return;
    if (!requirePermission(request, reply, "project.read")) return;
    const gscCfg = requireGscConfig(reply); if (!gscCfg) return;
    const gsc = requireStore(reply); if (!gsc) return;

    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) return await sendError(reply, 404, "NOT_FOUND", "Project not found.");
    const project = await requireProject(organizationId, params.data.projectId, reply);
    if (!project) return;

    try {
      const accessToken = await getValidAccessToken({
        store: gsc,
        transport,
        key,
        clientId: gscCfg.clientId,
        clientSecret: gscCfg.clientSecret,
        organizationId,
        projectId: project.id,
      });
      const sites = await transport.listSites(accessToken);
      return await reply.send({ sites });
    } catch (err) {
      return await sendGscFailure(reply, err);
    }
  });

  // ─── 4. Associate a property with a project ───
  app.post("/projects/:projectId/gsc/connections", async (request, reply) => {
    const organizationId = activeOrg(request, reply);
    if (!organizationId) return;
    if (!requirePermission(request, reply, "integration.manage")) return;
    const gscCfg = requireGscConfig(reply); if (!gscCfg) return;
    const gsc = requireStore(reply); if (!gsc) return;

    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) return await sendError(reply, 404, "NOT_FOUND", "Project not found.");
    const body = connectBody.safeParse(request.body);
    if (!body.success) {
      return await sendError(reply, 400, "VALIDATION_ERROR", "externalProperty is not a Google property.");
    }
    const project = await requireProject(organizationId, params.data.projectId, reply);
    if (!project) return;

    const credential = await gsc.getCredential(organizationId, project.id);
    if (!credential) {
      return await sendError(
        reply,
        409,
        "GSC_NOT_CONNECTED",
        "Complete the Google authorization flow before connecting a property.",
      );
    }

    try {
      const accessToken = await getValidAccessToken({
        store: gsc,
        transport,
        key,
        clientId: gscCfg.clientId,
        clientSecret: gscCfg.clientSecret,
        organizationId,
        projectId: project.id,
      });
      // Server-side authorization check: the property must be one Google
      // actually lists for THIS grant — a caller cannot attach a foreign property.
      const sites = await transport.listSites(accessToken);
      const authorized = sites.some((s) => s.siteUrl === body.data.externalProperty);
      if (!authorized) {
        return await sendError(
          reply,
          400,
          "GSC_PROPERTY_NOT_AUTHORIZED",
          "Google does not list this property for the connected account.",
        );
      }
      const connection = await gsc.createConnection({
        organizationId,
        projectId: project.id,
        externalProperty: body.data.externalProperty,
        credentialRef: credential.id,
      });
      return await reply.status(201).send({ connection });
    } catch (err) {
      if (isUniqueViolation(err) || err instanceof GscAlreadyConnectedError) {
        return await sendError(reply, 409, "GSC_ALREADY_CONNECTED", "Property already connected.");
      }
      return await sendGscFailure(reply, err);
    }
  });

  // ─── 5. Disconnect: revoke at Google, erase local material ───
  app.delete("/gsc/connections/:connectionId", async (request, reply) => {
    const organizationId = activeOrg(request, reply);
    if (!organizationId) return;
    if (!requirePermission(request, reply, "integration.manage")) return;
    const gscCfg = requireGscConfig(reply); if (!gscCfg) return;
    const gsc = requireStore(reply); if (!gsc) return;

    const params = z.object({ connectionId: z.uuid() }).safeParse(request.params);
    if (!params.success) return await sendError(reply, 404, "NOT_FOUND", "Connection not found.");
    const connection = await gsc.getConnection(organizationId, params.data.connectionId);
    if (!connection) return await sendError(reply, 404, "NOT_FOUND", "Connection not found.");

    const hadConfig = Boolean(gscCfg);
    if (hadConfig) {
      try {
        await disconnectGoogle({
          store: gsc,
          transport,
          key,
          clientId: gscCfg.clientId,
          clientSecret: gscCfg.clientSecret,
          organizationId,
          projectId: connection.projectId,
        });
      } catch (err) {
        // Local material is already gone; surface the revocation failure so an
        // operator can retry the Google-side revoke.
        request.log.warn(
          { err: err instanceof GscApiError ? err.code : "UNKNOWN" },
          "Google token revocation failed; local material already erased",
        );
      }
    }

    // One credential serves every connection of the project: disconnect them all.
    const siblings = await gsc.listConnections(organizationId, connection.projectId);
    for (const sibling of siblings) {
      await gsc.disconnectConnection(organizationId, sibling.id);
    }
    const fresh = await gsc.getConnection(organizationId, connection.id);
    return await reply.send({ status: "disconnected", connection: fresh });
  });

  // ─── 6. Search Analytics ingestion ───
  app.post("/projects/:projectId/gsc/sync", async (request, reply) => {
    const organizationId = activeOrg(request, reply);
    if (!organizationId) return;
    if (!requirePermission(request, reply, "integration.manage")) return;
    const gscCfg = requireGscConfig(reply); if (!gscCfg) return;
    const gsc = requireStore(reply); if (!gsc) return;

    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) return await sendError(reply, 404, "NOT_FOUND", "Project not found.");
    const body = syncBody.safeParse(request.body);
    if (!body.success) {
      return await sendError(reply, 400, "VALIDATION_ERROR", "Invalid sync window or connection.");
    }
    const project = await requireProject(organizationId, params.data.projectId, reply);
    if (!project) return;

    const connection = await gsc.getConnection(organizationId, body.data.connectionId);
    // Two steps, not one compound condition: after the project check passes,
    // TypeScript has already proven `connection` exists, so a repeated optional
    // chain would be dead — and a merged `!connection || …` form is the pattern
    // the optional-chain rule wants rewritten anyway.
    if (connection?.projectId !== project.id) {
      return await sendError(reply, 404, "NOT_FOUND", "Connection not found.");
    }
    if (connection.status !== "CONNECTED") {
      return await sendError(reply, 404, "NOT_FOUND", "Connection not found.");
    }

    // An explicit window wins; otherwise the job is incremental: it re-covers
    // Google's revision window since the connection's last completed sync.
    const today = new Date().toISOString().slice(0, 10);
    const window: WindowPair =
      body.data.startDate && body.data.endDate
        ? { startDate: body.data.startDate, endDate: body.data.endDate }
        : deriveIncrementalWindow(connection.lastSyncAt?.slice(0, 10) ?? null, today);
    const problem = windowError(window);
    if (problem) return await sendError(reply, 400, "INVALID_WINDOW", problem);

    try {
      const outcome = await runGscIngest(
        {
          store: gsc,
          transport,
          key,
          clientId: gscCfg.clientId,
          clientSecret: gscCfg.clientSecret,
          organizationId,
          projectId: project.id,
          connectionId: connection.id,
          property: connection.externalProperty,
        },
        window,
      );
      return await reply.send({ outcome });
    } catch (err) {
      return await sendGscFailure(reply, err);
    }
  });

  // ─── 7. Retry a failed/scheduled job (same idempotent job row) ───
  app.post("/gsc/jobs/:jobId/retry", async (request, reply) => {
    const organizationId = activeOrg(request, reply);
    if (!organizationId) return;
    if (!requirePermission(request, reply, "integration.manage")) return;
    const gscCfg = requireGscConfig(reply); if (!gscCfg) return;
    const gsc = requireStore(reply); if (!gsc) return;

    const params = z.object({ jobId: z.uuid() }).safeParse(request.params);
    if (!params.success) return await sendError(reply, 404, "NOT_FOUND", "Job not found.");
    const job = await gsc.getJob(organizationId, params.data.jobId);
    if (!job) return await sendError(reply, 404, "NOT_FOUND", "Job not found.");

    const connection = await gsc.getConnection(organizationId, job.connectionId);
    if (!connection) return await sendError(reply, 404, "NOT_FOUND", "Connection not found.");
    if (!canRetryJob(job, Date.now())) {
      return await sendError(reply, 409, "GSC_JOB_NOT_RETRYABLE", "This job cannot be retried now.");
    }

    try {
      const outcome = await runGscIngest(
        {
          store: gsc,
          transport,
          key,
          clientId: gscCfg.clientId,
          clientSecret: gscCfg.clientSecret,
          organizationId,
          projectId: job.projectId,
          connectionId: job.connectionId,
          property: connection.externalProperty,
        },
        { startDate: job.windowStart, endDate: job.windowEnd },
      );
      return await reply.send({ outcome });
    } catch (err) {
      return await sendGscFailure(reply, err);
    }
  });

  // ─── 8. Job list (freshness/status surface) ───
  app.get("/projects/:projectId/gsc/jobs", async (request, reply) => {
    const organizationId = activeOrg(request, reply);
    if (!organizationId) return;
    if (!requirePermission(request, reply, "project.read")) return;
    const gsc = requireStore(reply); if (!gsc) return;

    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) return await sendError(reply, 404, "NOT_FOUND", "Project not found.");
    const project = await requireProject(organizationId, params.data.projectId, reply);
    if (!project) return;
    const jobs = await gsc.listJobs(organizationId, project.id);
    const connections = await gsc.listConnections(organizationId, project.id);
    return await reply.send({ jobs, connections });
  });
}

/** Extract the stable Google subject from an id_token payload (no signature needed here). */
function subjectFromIdToken(idToken: string): string | null {
  const parts = idToken.split(".");
  const payloadPart = parts[1];
  if (parts.length !== 3 || payloadPart === undefined) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as {
      sub?: unknown;
    };
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "23505";
}
