import Fastify from "fastify";
import type { FastifyError } from "fastify";
// FastifyError claims `code: string`, but the error handler below also receives
// plain Error instances thrown by application code, where `code` is absent at
// runtime — model that reality instead of asserting it away.
interface HandlerError extends Error {
  code?: string;
  statusCode?: number;
}
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { logger } from "@serpvera/telemetry";
import { loadConfig } from "@serpvera/config";
import type { Session, TenantContext } from "./auth/session.ts";
import { readCookieToken, verifySession } from "./auth/session.ts";
import type { ApiStores } from "./stores/types.ts";
import {
  createStores,
  resolveStoreDriver,
  assertStoreDriverAllowed,
  type CreateStoresOptions,
  type StoreDriver,
} from "./stores/index.ts";
import { inspectDatabaseReadiness, type DatabaseReadiness } from "./stores/db.ts";
import { isReadinessReady, type ReadinessChecks } from "./stores/readiness.ts";
import { authRoutes } from "./routes/auth.ts";
import { orgRoutes } from "./routes/organizations.ts";
import { projectRoutes } from "./routes/projects.ts";
import { scanRoutes } from "./routes/scans.ts";
import { workspaceRoutes, findingRoutes } from "./routes/workspace.ts";
import { actionRoutes, projectActionRoutes } from "./routes/actions.ts";
import { gscRoutes } from "./routes/gsc.ts";
import { gscDataRoutes } from "./routes/gsc-data.ts";
import { aiVisibilityRoutes } from "./routes/ai-visibility.ts";
import { mfaRoutes } from "./routes/mfa.ts";
import { patchRoutes, projectAutofixRoutes } from "./routes/autofix.ts";
import { HttpGoogleTransport, type GoogleTransport } from "./integrations/gsc/google-transport.ts";
import { auditDomain, type AuditOptions } from "./audit/domain-audit.ts";
import { renderUrl } from "@serpvera/crawler";
import type { FixturePageAdapter } from "./autofix/workflow.ts";

declare module "fastify" {
  interface FastifyInstance {
    stores: ApiStores;
    /** Google transport — injected in tests so the wire stays deterministic. */
    gscTransport: GoogleTransport;
    /** Guarded domain audit; tests inject deterministic fixture input. */
    auditDomain: typeof auditDomain;
    /** Local fixture page adapter; never available in production. */
    fixturePageAdapter: FixturePageAdapter | null;
  }
  interface FastifyRequest {
    session: Session | null;
    tenant: TenantContext | null;
  }
}

const config = loadConfig();

export interface BuildAppOptions extends CreateStoresOptions {
  driver?: StoreDriver;
  /** Overrides the Google transport (tests inject a fake; production uses HTTP). */
  gscTransport?: GoogleTransport;
  /** Overrides the audit pipeline (tests inject fixtures; production uses the guarded crawler). */
  auditDomain?: typeof auditDomain;
  /** Test-only site/CMS simulator used by the proven-patch flow. */
  fixturePageAdapter?: FixturePageAdapter;
  /** Database readiness seam for deterministic tests; never available in production. */
  databaseReadiness?: () => Promise<DatabaseReadiness>;
}

export function assertDatabaseReadinessOverrideAllowed(
  nodeEnv: string,
  hasOverride: boolean,
): void {
  if (nodeEnv === "production" && hasOverride) {
    throw new Error("Database readiness overrides are disabled in production.");
  }
}

export async function buildApp(opts: BuildAppOptions = {}) {
  if (config.nodeEnv === "production" && opts.fixturePageAdapter) {
    throw new Error("Fixture page adapters are disabled in production.");
  }
  if (config.nodeEnv === "production" && opts.auditDomain) {
    throw new Error("Audit runner overrides are disabled in production.");
  }
  assertDatabaseReadinessOverrideAllowed(config.nodeEnv, Boolean(opts.databaseReadiness));
  const app = Fastify({
    logger: { level: config.nodeEnv === "production" ? "info" : "debug" },
    // TRUST_PROXY=true is REQUIRED behind a reverse proxy/load balancer:
    // without it request.ip is the proxy's address, so per-IP rate limits
    // (P-GAP-06) would quota every client as one. Off by default (safe:
    // never trust X-Forwarded-For from an untrusted network).
    trustProxy: process.env.TRUST_PROXY === "true",
  });

  // ─── Stores: production=postgres (RLS), tests=memory (explicit) ───
  const storeDriver = opts.driver ?? resolveStoreDriver();
  assertStoreDriverAllowed(storeDriver, config.nodeEnv);
  app.decorate("stores", createStores({ ...opts, driver: storeDriver }));
  app.decorate("fixturePageAdapter", opts.fixturePageAdapter ?? null);
  app.decorate("gscTransport", opts.gscTransport ?? new HttpGoogleTransport());
  const configuredAuditDomain =
    config.nodeEnv === "production"
      ? (target: string, traceId: string, options: AuditOptions = {}) =>
          auditDomain(target, traceId, {
            ...options,
            render: options.render ?? renderUrl,
          })
      : auditDomain;
  app.decorate("auditDomain", opts.auditDomain ?? configuredAuditDomain);
  // Loud driver announcement: a boot must never SILENTLY believe it is persistent.
  if (storeDriver === "postgres") {
    app.log.info(
      {
        driver: storeDriver,
        role: opts.runtimeRole ?? process.env.DB_RUNTIME_ROLE ?? "serpvera_app",
      },
      "store driver: postgres — persistence + RLS enforced",
    );
  } else {
    app.log.warn(
      { driver: storeDriver },
      "store driver: MEMORY — no persistence (test/fixture use only; set STORE_DRIVER=postgres for durable runs)",
    );
  }

  // ─── Session hook (inlined; plugin encapsulation blocks req.raw) ───
  app.decorateRequest("session", null);
  app.decorateRequest("tenant", null);

  app.addHook("onRequest", async (request) => {
    request.session = null;
    request.tenant = null;

    // Opaque token → server-side session lookup. Unknown/revoked/expired
    // tokens all resolve to null (unauthenticated) — the cookie alone proves
    // nothing that the server did not itself issue and has not revoked.
    const session = await verifySession(app.stores.sessions, readCookieToken(request));
    if (!session) return;

    request.session = session;
    // Tenant context comes from the SERVER-held session row. Routes STILL
    // re-verify active membership server-side (defence in depth), and RLS is
    // the final boundary — see routes/projects.ts getForRequester check.
    if (session.organizationId) {
      request.tenant = {
        organizationId: session.organizationId,
        userId: session.userId,
        role: session.role ?? "VIEWER",
      };
    }
  });

  await app.register(cors, { origin: config.app.url, credentials: true });

  // ─── Error handler ───
  // MUST be registered BEFORE any route/plugin. Fastify error handlers are
  // scope-encapsulated: a scope created by `register()` snapshots the handler
  // that exists at registration time, so setting this afterwards silently leaves
  // child scopes on Fastify's default handler — which echoes the raw error
  // message (leaking Zod schema/regex internals) as a 500.
  app.setErrorHandler((error: FastifyError | HandlerError, _request, reply) => {
    // Input validation → 400 with a generic message. The raw Zod issue array is
    // deliberately NOT echoed back: it leaks internal schema/regex details.
    // Full detail is logged server-side only.
    if (error instanceof ZodError) {
      logger.warn("Request validation failed", { issues: error.issues.length });
      void reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "Invalid request body." },
      });
      return;
    }

    // Errors raised by our own code with an explicit statusCode (requireAuth,
    // Duplicate*Error mapping, etc.) are safe to surface.
    const status = typeof error.statusCode === "number" ? error.statusCode : undefined;

    if (status === 401 || status === 403) {
      void reply.status(status).send({
        error: {
          code: status === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
          message: error.message,
        },
      });
      return;
    }

    if (status === 400 || status === 404 || status === 409 || status === 413) {
      void reply.status(status).send({
        error: { code: error.code ?? "BAD_REQUEST", message: error.message },
      });
      return;
    }

    // Everything else: log the detail, return an opaque 500.
    logger.error("Unhandled error", {
      error: error.message,
      stack: error.stack,
    });
    void reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Internal error" } });
  });

  // Liveness only: a live process should not be restarted because a dependency
  // is temporarily unavailable. Load balancers should use /ready for routing.
  app.get("/health", () => ({ status: "ok", version: "0.1.0" }));
  app.get("/ready", async (_request, reply) => {
    const checks: ReadinessChecks =
      storeDriver === "postgres"
        ? {
            coreConfiguration: "valid",
            store: storeDriver,
            ...(await (opts.databaseReadiness ?? inspectDatabaseReadiness)()),
          }
        : {
            coreConfiguration: "valid",
            store: storeDriver,
            database: "not_required",
            requiredSchemaChecks: "not_required",
            migrationState: "not_required",
            latestMigration: null,
            requiredMigration: null,
            verifiedSchemaMarkers: [],
            requiredSchemaMarkers: [],
          };
    const ready = isReadinessReady(checks);
    return reply.status(ready ? 200 : 503).send({
      status: ready ? "ready" : "not_ready",
      checks,
    });
  });
  await app.register(authRoutes, { prefix: "/v1/auth" });
  await app.register(mfaRoutes, { prefix: "/v1/auth/mfa" });
  await app.register(orgRoutes, { prefix: "/v1/organizations" });
  await app.register(projectRoutes, { prefix: "/v1/projects" });
  await app.register(workspaceRoutes, { prefix: "/v1/projects" });
  await app.register(projectActionRoutes, { prefix: "/v1/projects" });
  await app.register(findingRoutes, { prefix: "/v1/findings" });
  await app.register(actionRoutes, { prefix: "/v1/actions" });
  await app.register(projectAutofixRoutes, { prefix: "/v1/projects" });
  await app.register(patchRoutes, { prefix: "/v1/autofix" });
  await app.register(gscRoutes, { prefix: "/v1" });
  await app.register(gscDataRoutes, { prefix: "/v1" });
  await app.register(aiVisibilityRoutes, { prefix: "/v1/projects" });
  await app.register(scanRoutes, { prefix: "/v1/public-scans" });

  // Close the DB pool on shutdown when using the postgres driver.
  app.addHook("onClose", async () => {
    try {
      const { closeDbStores } = await import("./stores/db.ts");
      await closeDbStores();
    } catch {
      /* memory driver or pool already closed */
    }
  });

  return app;
}

const isMain = process.argv[1]?.includes("server");
if (isMain) {
  const app = await buildApp();
  await app.listen({
    port: parseInt(process.env.PORT ?? "3001", 10),
    host: "0.0.0.0",
  });
  logger.info("API server listening");
}
