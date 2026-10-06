import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hasPermission } from "@serpvera/authz";
import {
  sha256,
  type PatchActor,
  type PatchProposal,
  ProvenPatchWorkflow,
  InMemoryFixtureCms,
  PatchWorkflowError,
  serverVerifiedStepUpProof,
  inspectPatchTarget,
  type FixturePageAdapter,
} from "../autofix/workflow.ts";
import { consumeStepUpCode } from "./mfa.ts";
import { requireAuth } from "../auth/session.ts";

const ORIGINAL_HTML =
  '<!doctype html><html lang="en"><head><title>Coffee Brewing Guide</title><link rel="canonical" href="https://fixture.invalid/guide"></head><body><main><h1>Ceramic dripper brewing guide</h1><p>Ceramic dripper brewing guide for home kitchens.</p><img id="hero" src="/dripper.jpg" alt=""></main></body></html>';
const VISIBLE_TEXT = "Ceramic dripper brewing guide for home kitchens.";
const demoSchema = z.object({ field: z.enum(["image_alt", "title"]) });
const mutationSchema = z.object({ expectedVersion: z.number().int().positive() });

interface ActiveContext {
  organizationId: string;
  actor: PatchActor;
  role: NonNullable<FastifyRequest["session"]>["role"];
}

function enabledOutsideProduction(): boolean {
  return process.env.NODE_ENV !== "production";
}

function requireContext(request: FastifyRequest, reply: FastifyReply): ActiveContext | null {
  try {
    requireAuth(request, reply);
  } catch {
    return null;
  }
  const session = request.session;
  if (!session.organizationId) {
    void reply.status(400).send({
      error: { code: "NO_ACTIVE_ORGANIZATION", message: "Select an organization first." },
    });
    return null;
  }
  return {
    organizationId: session.organizationId,
    role: session.role,
    actor: { organizationId: session.organizationId, userId: session.userId, email: session.email },
  };
}

function requirePermission(
  context: ActiveContext,
  reply: FastifyReply,
  permission: "action.approve" | "production.write",
): boolean {
  if (context.role && hasPermission(context.role, permission)) return true;
  void reply.status(403).send({
    error: { code: "FORBIDDEN", message: `Role cannot perform ${permission}.` },
  });
  return false;
}

function publicProposal(proposal: PatchProposal): Omit<PatchProposal, "evidence"> & {
  evidence: Omit<PatchProposal["evidence"], "rawHtml">;
} {
  const { rawHtml: _rawHtml, ...evidence } = proposal.evidence;
  return { ...proposal, evidence };
}

function sendWorkflowError(reply: FastifyReply, error: unknown) {
  if (error instanceof PatchWorkflowError) {
    const status =
      error.code === "FIXTURE_ONLY" ? 404 : error.code === "STEP_UP_REQUIRED" ? 403 : 409;
    void reply.status(status).send({ error: { code: error.code, message: error.message } });
    return;
  }
  throw error;
}

function fixtureClock(afterAt?: string): () => Date {
  const previous = afterAt ? Date.parse(afterAt) : Number.NaN;
  let tick = Math.max(Date.now(), Number.isFinite(previous) ? previous : 0);
  return () => new Date(++tick);
}

function workflowFor(
  url: string,
  html: string,
  afterAt?: string,
  adapter?: FixturePageAdapter | null,
): { cms: FixturePageAdapter; workflow: ProvenPatchWorkflow } {
  const clock = fixtureClock(afterAt);
  const cms = adapter ?? new InMemoryFixtureCms({ [url]: html }, clock);
  return { cms, workflow: new ProvenPatchWorkflow(cms, clock) };
}

export function projectAutofixRoutes(app: FastifyInstance) {
  app.get("/:projectId/autofix/patches", async (request, reply) => {
    if (!enabledOutsideProduction())
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Not found." } });
    const context = requireContext(request, reply);
    if (!context) return;
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success)
      return reply
        .status(400)
        .send({ error: { code: "INVALID_ID", message: "Project id must be a UUID." } });
    const project = await app.stores.projects.getProject(
      context.organizationId,
      params.data.projectId,
    );
    if (!project)
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Project not found." } });
    const patches = await app.stores.patches.list(context.organizationId, project.id);
    return reply.send({ mode: "fixture", patches: patches.map(publicProposal) });
  });

  app.post("/:projectId/autofix/demo", async (request, reply) => {
    if (!enabledOutsideProduction())
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Not found." } });
    const context = requireContext(request, reply);
    if (!context || !requirePermission(context, reply, "action.approve")) return;
    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    const body = demoSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.status(400).send({
        error: { code: "INVALID_DEMO_INPUT", message: "Choose an alt or title fixture." },
      });
    const project = await app.stores.projects.getProject(
      context.organizationId,
      params.data.projectId,
    );
    if (!project)
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Project not found." } });

    const url =
      app.fixturePageAdapter?.pageUrls()[0] ?? `https://fixture.invalid/${randomUUID()}/guide`;
    const cms =
      app.fixturePageAdapter ??
      new InMemoryFixtureCms(
        { [url]: ORIGINAL_HTML.replaceAll("https://fixture.invalid/guide", url) },
        fixtureClock(),
      );
    const source = await cms.read(url, "browser", "raw");
    if (source.status !== 200 || !source.contentType.includes("text/html")) {
      return reply.status(409).send({
        error: { code: "FIXTURE_UNAVAILABLE", message: "The local page fixture is unavailable." },
      });
    }
    const fixtureHtml = source.html;
    const isAlt = body.data.field === "image_alt";
    const currentTarget = inspectPatchTarget(
      fixtureHtml,
      body.data.field,
      isAlt ? "hero" : undefined,
    );
    if (currentTarget.count !== 1 || (!isAlt && currentTarget.value === null)) {
      return reply.status(409).send({
        error: {
          code: "FIXTURE_TARGET_CONFLICT",
          message: "The fixture must contain exactly one patch target with a readable value.",
        },
      });
    }
    const finding = await app.stores.crawl.addFinding(context.organizationId, project.id, {
      ruleId: isAlt ? "FIXTURE_IMAGE_ALT_MISSING" : "FIXTURE_TITLE_NEEDS_REVIEW",
      ruleVersion: "1.0.0",
      title: isAlt
        ? "Fixture image is missing alternative text"
        : "Fixture title needs an evidence-backed rewrite",
      epistemicClass: "DETERMINISTIC",
      severity: isAlt ? "medium" : "low",
      explanation: "Local fixture used to demonstrate the controlled patch workflow.",
      recommendation: isAlt
        ? "Add a concise alt grounded in the reviewed image and page text."
        : "Use a concise title grounded in visible page text.",
      affectedUrls: [url],
      verificationGate: "fixture_content_parity",
    });
    const evidenceHash = sha256(fixtureHtml);
    const evidenceInput = {
      kind: "fixture_html",
      sourceRef: `fixture:${url}`,
      contentHash: evidenceHash,
      objectKey: `fixture/${finding.id}`,
      metadata: { mode: "fixture", capturedAt: new Date().toISOString() },
    };
    const storedEvidence = await app.stores.crawl.addEvidence(
      context.organizationId,
      project.id,
      evidenceInput,
    );
    await app.stores.crawl.linkFindingEvidence(
      context.organizationId,
      finding.id,
      storedEvidence.id,
    );

    const { workflow } = workflowFor(url, fixtureHtml, undefined, cms);
    const proposal = await workflow.propose({
      organizationId: context.organizationId,
      projectId: project.id,
      findingId: finding.id,
      evidence: {
        url,
        capturedAt: new Date().toISOString(),
        rawHtml: fixtureHtml,
        contentHash: evidenceHash,
        visibleText: VISIBLE_TEXT,
        ...(isAlt
          ? { visualReview: { role: "informative" as const, description: "Ceramic dripper." } }
          : {}),
      },
      change: isAlt
        ? {
            field: "image_alt",
            before: currentTarget.value,
            after: "Ceramic dripper",
            imageId: "hero",
            imageRole: "informative",
          }
        : {
            field: "title",
            before: currentTarget.value,
            after: "Ceramic Dripper Guide for Home Kitchens",
          },
    });
    const storedPage = await cms.read(url, "browser", "raw");
    await app.stores.patches.create({
      organizationId: context.organizationId,
      projectId: project.id,
      findingId: finding.id,
      actor: context.actor,
      proposal,
      fixtureHtml: storedPage.html,
    });
    return reply.status(201).send({ mode: "fixture", patch: publicProposal(proposal) });
  });
}

export function patchRoutes(app: FastifyInstance) {
  app.get("/:patchId", async (request, reply) => {
    if (!enabledOutsideProduction())
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Not found." } });
    const context = requireContext(request, reply);
    if (!context) return;
    const params = z.object({ patchId: z.uuid() }).safeParse(request.params);
    if (!params.success)
      return reply
        .status(400)
        .send({ error: { code: "INVALID_ID", message: "Patch id must be a UUID." } });
    const stored = await app.stores.patches.get(context.organizationId, params.data.patchId);
    if (!stored)
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Patch not found." } });
    return reply.send({ mode: "fixture", patch: publicProposal(stored.proposal) });
  });

  app.post("/:patchId/preview", async (request, reply) =>
    mutate(app, request, reply, "action.approve", async ({ workflow, patch, body }) => {
      if (patch.version !== body.expectedVersion)
        throw new PatchWorkflowError("PATCH_CONFLICT", "Patch version is stale.");
      await workflow.preview(patch.organizationId, patch.id);
    }),
  );

  app.post("/:patchId/approve", async (request, reply) =>
    mutate(app, request, reply, "action.approve", ({ workflow, patch, body, actor }) => {
      const input = z
        .object({
          expectedVersion: z.number().int().positive(),
          contentHash: z.string().regex(/^[0-9a-f]{64}$/),
        })
        .parse(body);
      if (patch.version !== input.expectedVersion)
        throw new PatchWorkflowError("PATCH_CONFLICT", "Patch version is stale.");
      workflow.approve(patch.organizationId, patch.id, actor, input.contentHash);
    }),
  );

  app.post("/:patchId/deploy", async (request, reply) =>
    mutate(
      app,
      request,
      reply,
      "production.write",
      async ({ app, request, reply, workflow, patch, body, actor }) => {
        const input = z
          .object({
            expectedVersion: z.number().int().positive(),
            code: z.string().regex(/^\d{6}$/),
          })
          .parse(body);
        if (patch.version !== input.expectedVersion)
          throw new PatchWorkflowError("PATCH_CONFLICT", "Patch version is stale.");
        const stepUp = await consumeStepUpCode(app, request, reply, actor.userId, input.code);
        if (!stepUp) return;
        await workflow.deploy(
          patch.organizationId,
          patch.id,
          actor,
          serverVerifiedStepUpProof(actor.userId, stepUp.verifiedAt),
        );
      },
    ),
  );

  app.post("/:patchId/manual", async (request, reply) =>
    mutate(
      app,
      request,
      reply,
      "production.write",
      async ({ app, request, reply, workflow, patch, body, actor }) => {
        const input = z
          .object({
            expectedVersion: z.number().int().positive(),
            code: z.string().regex(/^\d{6}$/),
          })
          .parse(body);
        if (patch.version !== input.expectedVersion)
          throw new PatchWorkflowError("PATCH_CONFLICT", "Patch version is stale.");
        const stepUp = await consumeStepUpCode(app, request, reply, actor.userId, input.code);
        if (!stepUp) return;
        await workflow.deployManually(
          patch.organizationId,
          patch.id,
          actor,
          serverVerifiedStepUpProof(actor.userId, stepUp.verifiedAt),
        );
      },
    ),
  );

  app.post("/:patchId/verify", async (request, reply) =>
    mutate(app, request, reply, "action.approve", async ({ workflow, patch, body }) => {
      if (patch.version !== body.expectedVersion)
        throw new PatchWorkflowError("PATCH_CONFLICT", "Patch version is stale.");
      await workflow.verify(patch.organizationId, patch.id);
    }),
  );

  app.post("/:patchId/rollback", async (request, reply) =>
    mutate(
      app,
      request,
      reply,
      "production.write",
      async ({ app, request, reply, workflow, patch, body, actor }) => {
        const input = z
          .object({
            expectedVersion: z.number().int().positive(),
            code: z.string().regex(/^\d{6}$/),
          })
          .parse(body);
        if (patch.version !== input.expectedVersion)
          throw new PatchWorkflowError("PATCH_CONFLICT", "Patch version is stale.");
        const stepUp = await consumeStepUpCode(app, request, reply, actor.userId, input.code);
        if (!stepUp) return;
        await workflow.rollback(patch.organizationId, patch.id);
      },
    ),
  );
}

async function mutate(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  permission: "action.approve" | "production.write",
  operation: (context: {
    app: FastifyInstance;
    request: FastifyRequest;
    reply: FastifyReply;
    actor: PatchActor;
    workflow: ProvenPatchWorkflow;
    patch: PatchProposal;
    body: { expectedVersion: number; [key: string]: unknown };
  }) => Promise<void> | void,
) {
  if (!enabledOutsideProduction())
    return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Not found." } });
  const context = requireContext(request, reply);
  if (!context || !requirePermission(context, reply, permission)) return;
  const params = z.object({ patchId: z.uuid() }).safeParse(request.params);
  const parsedBody = mutationSchema.loose().safeParse(request.body);
  if (!params.success || !parsedBody.success)
    return reply.status(400).send({
      error: {
        code: "INVALID_PATCH_INPUT",
        message: "Patch id and expected version are required.",
      },
    });
  const stored = await app.stores.patches.get(context.organizationId, params.data.patchId);
  if (!stored)
    return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Patch not found." } });
  const project = await app.stores.projects.getProject(
    context.organizationId,
    stored.proposal.projectId,
  );
  if (!project)
    return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Patch not found." } });
  const { cms, workflow } = workflowFor(
    stored.proposal.url,
    stored.fixtureHtml,
    stored.proposal.events.at(-1)?.at,
    app.fixturePageAdapter,
  );
  try {
    workflow.restore(stored.proposal);
    await operation({
      app,
      request,
      reply,
      actor: context.actor,
      workflow,
      patch: stored.proposal,
      body: parsedBody.data,
    });
  } catch (error) {
    const current = safeWorkflowGet(workflow, context.organizationId, stored.proposal.id);
    if (
      current &&
      (current.version !== stored.proposal.version || current.events.length !== stored.eventCount)
    ) {
      await persistMutation(
        app,
        context.organizationId,
        stored.proposal,
        stored.eventCount,
        current,
        cms,
      );
    }
    sendWorkflowError(reply, error);
    return;
  }
  if (reply.sent) return;
  const current = workflow.get(context.organizationId, stored.proposal.id);
  if (current.version === stored.proposal.version && current.events.length === stored.eventCount) {
    return reply
      .status(409)
      .send({ error: { code: "NO_PATCH_CHANGE", message: "No patch state change occurred." } });
  }
  const saved = await persistMutation(
    app,
    context.organizationId,
    stored.proposal,
    stored.eventCount,
    current,
    cms,
  );
  if (!saved)
    return reply.status(409).send({
      error: {
        code: "VERSION_CONFLICT",
        message: "Patch changed during this operation. Reload before retrying.",
      },
    });
  return reply.send({ mode: "fixture", patch: publicProposal(current) });
}

function safeWorkflowGet(
  workflow: ProvenPatchWorkflow,
  organizationId: string,
  patchId: string,
): PatchProposal | null {
  try {
    return workflow.get(organizationId, patchId);
  } catch {
    return null;
  }
}

async function persistMutation(
  app: FastifyInstance,
  organizationId: string,
  previous: PatchProposal,
  eventCount: number,
  current: PatchProposal,
  cms: FixturePageAdapter,
): Promise<boolean> {
  const page = await cms.read(current.url, "browser", "raw");
  if (page.status !== 200) return false;
  return app.stores.patches.save({
    organizationId,
    patchId: current.id,
    expectedVersion: previous.version,
    previousEventCount: eventCount,
    proposal: current,
    fixtureHtml: page.html,
  });
}
