// ─── GSC data routes: performance, breakdowns, intelligence, Action Center ───
//
// These endpoints read only what has already been persisted from Google — they
// never call Google themselves. Every number they return therefore has a row in
// gsc_query_metrics behind it, and freshness is reported alongside so a stale
// window can never masquerade as live data.

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { activeOrg, requirePermission } from "../auth/request-context.ts";
import {
  emergingQueries,
  highImpressionsLowCtr,
  pageQueryDecay,
  pageQueryIntersections,
  prePostComparison,
  queryCannibalization,
  rankingOpportunityWindows,
  recommendationRuleId,
  summarizeByDimension,
  winnersLosers,
  type MeasuredRecommendation,
  type MetricRow,
  type MetricWindow,
} from "../integrations/gsc/intelligence.ts";
import type { GscStore } from "../stores/types.ts";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const filtersQuery = z.object({
  startDate: isoDate,
  endDate: isoDate,
  query: z.string().max(500).optional(),
  page: z.string().max(2000).optional(),
  device: z.enum(["DESKTOP", "MOBILE", "TABLET"]).optional(),
  country: z.string().max(8).optional(),
});

const breakdownQuery = filtersQuery.extend({
  dimension: z.enum(["query", "page"]),
  limit: z.string().regex(/^\d+$/).optional(),
});

const intelligenceQuery = filtersQuery.extend({
  module: z.string().max(64).optional(),
  baselineStart: isoDate.optional(),
  baselineEnd: isoDate.optional(),
});

const metricValue = z.union([z.string(), z.number(), z.boolean()]);
const recommendationSchema = z.object({
  module: z.string().min(1).max(64),
  subject: z.object({
    query: z.string().max(500).optional(),
    page: z.string().max(2000).optional(),
    device: z.string().max(16).optional(),
    country: z.string().max(8).optional(),
  }),
  title: z.string().min(1).max(500),
  rationale: z.string().max(4000),
  datasetWindow: z.object({ startDate: isoDate, endDate: isoDate }),
  filters: z.record(z.string(), metricValue),
  comparisonWindow: z.object({ startDate: isoDate, endDate: isoDate }).optional(),
  observed: z.record(z.string(), metricValue),
  baseline: z.record(z.string(), metricValue).optional(),
  delta: z.record(z.string(), z.number()).optional(),
  // Hard integrity requirements: nothing but a measurement may become a finding,
  // and only the declared GSC gate may verify it.
  evidenceClass: z.literal("MEASURED"),
  verificationGate: z.object({
    type: z.literal("gsc_window"),
    spec: z.object({
      metric: z.enum(["ctr", "clicks", "impressions", "position"]),
      operator: z.enum(["gte", "lte"]),
      threshold: z.number(),
      query: z.string().max(500).optional(),
      page: z.string().max(2000).optional(),
      minImpressions: z.number().min(0),
      windowDays: z.number().int().min(1).max(366),
    }),
  }),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
});

type Filters = z.infer<typeof filtersQuery>;

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

function windowError(window: { startDate: string; endDate: string }): string | null {
  const start = Date.parse(`${window.startDate}T00:00:00Z`);
  const end = Date.parse(`${window.endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "Malformed date.";
  if (end < start) return "endDate must not precede startDate.";
  if ((end - start) / 86_400_000 > 366) return "Window exceeds 366 days.";
  return null;
}

function toFilters(q: Filters): {
  query?: string;
  page?: string;
  device?: string;
  country?: string;
} {
  return {
    ...(q.query ? { query: q.query } : {}),
    ...(q.page ? { page: q.page } : {}),
    ...(q.device ? { device: q.device } : {}),
    ...(q.country ? { country: q.country } : {}),
  };
}

/** Baseline defaults to the same length immediately before the measurement window. */
function deriveBaselineWindow(
  current: MetricWindow,
  start: string | undefined,
  end: string | undefined,
): MetricWindow {
  if (start && end) return { startDate: start, endDate: end };
  const currentStart = Date.parse(`${current.startDate}T00:00:00Z`);
  const currentEnd = Date.parse(`${current.endDate}T00:00:00Z`);
  const span = currentEnd - currentStart;
  const baselineEnd = currentStart - 86_400_000;
  const baselineStart = baselineEnd - span;
  return {
    startDate: new Date(baselineStart).toISOString().slice(0, 10),
    endDate: new Date(baselineEnd).toISOString().slice(0, 10),
  };
}

export function gscDataRoutes(app: FastifyInstance) {
  const requireStore = (reply: FastifyReply): GscStore | null => {
    if (!app.stores.gsc) {
      void sendError(
        reply,
        501,
        "GSC_STORE_UNAVAILABLE",
        "Google data requires the PostgreSQL store driver.",
      );
      return null;
    }
    return app.stores.gsc;
  };

  const requireProject = async (
    organizationId: string,
    projectId: string,
    reply: FastifyReply,
  ): Promise<{ id: string; primaryDomain: string } | null> => {
    const project = await app.stores.projects.getProject(organizationId, projectId);
    if (!project) {
      void sendError(reply, 404, "NOT_FOUND", "Project not found.");
      return null;
    }
    return project;
  };

  // ─── Search Performance summary + daily series ───
  app.get("/projects/:projectId/gsc/summary", async (request, reply) => {
    const organizationId = activeOrg(request, reply);
    if (!organizationId) return;
    if (!requirePermission(request, reply, "project.read")) return;
    const gsc = requireStore(reply);
    if (!gsc) return;

    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) return await sendError(reply, 404, "NOT_FOUND", "Project not found.");
    const query = filtersQuery.safeParse(request.query);
    if (!query.success) {
      return await sendError(reply, 400, "VALIDATION_ERROR", "Invalid window or filters.");
    }
    const project = await requireProject(organizationId, params.data.projectId, reply);
    if (!project) return;
    const problem = windowError(query.data);
    if (problem) return await sendError(reply, 400, "INVALID_WINDOW", problem);

    const window = { startDate: query.data.startDate, endDate: query.data.endDate };
    const series = await gsc.metricSeries(
      organizationId,
      project.id,
      window,
      toFilters(query.data),
    );
    const clicks = series.reduce((sum, p) => sum + p.clicks, 0);
    const impressions = series.reduce((sum, p) => sum + p.impressions, 0);
    const weightedPosition = series.reduce((sum, p) => sum + p.position * p.impressions, 0);
    const freshness = await gsc.metricFreshness(organizationId, project.id);

    return await reply.send({
      window,
      filters: toFilters(query.data),
      totals: {
        clicks,
        impressions,
        ctr: impressions > 0 ? clicks / impressions : 0,
        position: impressions > 0 ? weightedPosition / impressions : 0,
        days: series.length,
      },
      series,
      freshness,
    });
  });

  // ─── Queries / pages breakdown ───
  app.get("/projects/:projectId/gsc/breakdown", async (request, reply) => {
    const organizationId = activeOrg(request, reply);
    if (!organizationId) return;
    if (!requirePermission(request, reply, "project.read")) return;
    const gsc = requireStore(reply);
    if (!gsc) return;

    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) return await sendError(reply, 404, "NOT_FOUND", "Project not found.");
    const query = breakdownQuery.safeParse(request.query);
    if (!query.success) {
      return await sendError(reply, 400, "VALIDATION_ERROR", "Invalid breakdown request.");
    }
    const project = await requireProject(organizationId, params.data.projectId, reply);
    if (!project) return;
    const problem = windowError(query.data);
    if (problem) return await sendError(reply, 400, "INVALID_WINDOW", problem);

    const window = { startDate: query.data.startDate, endDate: query.data.endDate };
    const rows = await gsc.loadMetricRows(organizationId, project.id, window, toFilters(query.data));
    const limit = query.data.limit ? Math.min(Number(query.data.limit), 1000) : 100;
    const grouped = summarizeByDimension(rows, query.data.dimension).slice(0, limit);
    const freshness = await gsc.metricFreshness(organizationId, project.id);

    return await reply.send({
      window,
      filters: toFilters(query.data),
      dimension: query.data.dimension,
      rows: grouped,
      totalGroups: grouped.length,
      sourceRows: rows.length,
      freshness,
    });
  });

  // ─── Intelligence modules ───
  app.get("/projects/:projectId/gsc/intelligence", async (request, reply) => {
    const organizationId = activeOrg(request, reply);
    if (!organizationId) return;
    if (!requirePermission(request, reply, "project.read")) return;
    const gsc = requireStore(reply);
    if (!gsc) return;

    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) return await sendError(reply, 404, "NOT_FOUND", "Project not found.");
    const query = intelligenceQuery.safeParse(request.query);
    if (!query.success) {
      return await sendError(reply, 400, "VALIDATION_ERROR", "Invalid intelligence request.");
    }
    const project = await requireProject(organizationId, params.data.projectId, reply);
    if (!project) return;
    const problem = windowError(query.data);
    if (problem) return await sendError(reply, 400, "INVALID_WINDOW", problem);

    const window = { startDate: query.data.startDate, endDate: query.data.endDate };
    const baseline = deriveBaselineWindow(
      window,
      query.data.baselineStart,
      query.data.baselineEnd,
    );
    const filters = toFilters(query.data);
    const current = await gsc.loadMetricRows(organizationId, project.id, window, filters);
    const needsBaseline =
      !query.data.module ||
      ["page_query_decay", "emerging_queries", "winners_losers", "pre_post_comparison"].includes(
        query.data.module,
      );
    const baselineRows = needsBaseline
      ? await gsc.loadMetricRows(organizationId, project.id, baseline, filters)
      : [];

    const recommendations = runModules(query.data.module, {
      current,
      baseline: baselineRows,
      window,
      baselineWindow: baseline,
    });
    const freshness = await gsc.metricFreshness(organizationId, project.id);

    return await reply.send({
      module: query.data.module ?? "all",
      window,
      comparisonWindow: baseline,
      filters,
      recommendations,
      counts: {
        total: recommendations.length,
        // Every recommendation is MEASURED by construction (the type admits
        // nothing else) — the two counts coincide without a runtime filter.
        measured: recommendations.length,
      },
      freshness,
    });
  });

  // ─── Promote a recommendation to a MEASURED finding + DETECTED action ───
  app.post("/projects/:projectId/gsc/findings", async (request, reply) => {
    const organizationId = activeOrg(request, reply);
    if (!organizationId) return;
    if (!requirePermission(request, reply, "project.read")) return;
    const gsc = requireStore(reply);
    if (!gsc) return;

    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) return await sendError(reply, 404, "NOT_FOUND", "Project not found.");
    const body = recommendationSchema.safeParse(request.body);
    if (!body.success) {
      return await sendError(
        reply,
        400,
        "VALIDATION_ERROR",
        "Recommendation must be a MEASURED GSC observation with a gsc_window gate.",
      );
    }
    const project = await requireProject(organizationId, params.data.projectId, reply);
    if (!project) return;
    const rec = body.data as MeasuredRecommendation;

    const ruleId = recommendationRuleId(rec);
    const affectedUrl = rec.subject.page ?? `https://${project.primaryDomain}`;

    // One open workflow per (rule, subject): re-running intelligence must not
    // spawn duplicate actions for the same measured claim.
    const existing = await app.stores.crawl.listFindings(organizationId, project.id);
    const duplicate = existing.find(
      (f) => f.ruleId === ruleId && f.affectedUrls.includes(affectedUrl) && f.status !== "resolved",
    );
    if (duplicate) {
      return await reply.send({
        created: false,
        findingId: duplicate.id,
        ruleId,
        reason: "an equivalent measured finding is already open",
      });
    }

    // Canonical payload → content hash: the evidence can be re-derived and
    // compared byte-for-byte against what the gate will later read.
    const canonical = JSON.stringify({
      module: rec.module,
      subject: rec.subject,
      datasetWindow: rec.datasetWindow,
      filters: rec.filters,
      comparisonWindow: rec.comparisonWindow ?? null,
      observed: rec.observed,
      evidenceClass: rec.evidenceClass,
      verificationGate: rec.verificationGate,
    });
    const contentHash = createHash("sha256").update(canonical).digest("hex");

    const finding = await app.stores.crawl.addFinding(organizationId, project.id, {
      ruleId,
      ruleVersion: "1.0.0",
      title: rec.title,
      epistemicClass: "MEASURED",
      severity: rec.severity,
      explanation: rec.rationale,
      recommendation: rec.title,
      affectedUrls: [affectedUrl],
      verificationGate: rec.verificationGate.type,
    });
    const evidence = await app.stores.crawl.addEvidence(organizationId, project.id, {
      kind: "gsc_data",
      sourceRef: `gsc://search-analytics?start=${rec.datasetWindow.startDate}&end=${rec.datasetWindow.endDate}&rule=${encodeURIComponent(ruleId)}`,
      contentHash,
      objectKey: `${organizationId}/${project.id}/gsc_data/${contentHash}`,
      metadata: {
        evidenceClass: rec.evidenceClass,
        module: rec.module,
        subject: rec.subject,
        datasetWindow: rec.datasetWindow,
        filters: rec.filters,
        comparisonWindow: rec.comparisonWindow ?? null,
        observed: rec.observed,
        baseline: rec.baseline ?? null,
        delta: rec.delta ?? null,
        verificationGate: rec.verificationGate,
        rationale: rec.rationale,
      },
    });
    await app.stores.crawl.linkFindingEvidence(organizationId, finding.id, evidence.id);
    const action = await app.stores.crawl.createDetectedAction(
      organizationId,
      project.id,
      finding.id,
    );

    return await reply.status(201).send({
      created: true,
      findingId: finding.id,
      evidenceId: evidence.id,
      actionId: action.id,
      ruleId,
      contentHash,
      epistemicClass: "MEASURED",
      verificationGate: rec.verificationGate.type,
    });
  });

  // ─── Action Center before/after over GSC measurements ───
  app.get("/gsc/actions/:actionId/before-after", async (request, reply) => {
    const organizationId = activeOrg(request, reply);
    if (!organizationId) return;
    if (!requirePermission(request, reply, "project.read")) return;
    const gsc = requireStore(reply);
    if (!gsc) return;

    const params = z.object({ actionId: z.uuid() }).safeParse(request.params);
    if (!params.success) return await sendError(reply, 404, "NOT_FOUND", "Action not found.");
    const action = await app.stores.actions.getAction(organizationId, params.data.actionId);
    if (!action) return await sendError(reply, 404, "NOT_FOUND", "Action not found.");

    const recommendation = action.recommendation as {
      verificationGate?: { spec?: Record<string, unknown> } | null;
    } | null;
    const spec = recommendation?.verificationGate?.spec;
    if (!spec) {
      return await sendError(
        reply,
        409,
        "GSC_GATE_NOT_DECLARED",
        "This action has no declared GSC gate yet (propose it first).",
      );
    }

    const comparison = action.comparisonWindow as { startsAt?: string; endsAt?: string } | null;
    const measurementWindow = windowFromIso(comparison?.startsAt, comparison?.endsAt);
    const baselineWindow = deriveBaselineWindow(measurementWindow, undefined, undefined);
    const subject = {
      ...(typeof spec.query === "string" ? { query: spec.query } : {}),
      ...(typeof spec.page === "string" ? { page: spec.page } : {}),
      ...(typeof spec.device === "string" ? { device: spec.device } : {}),
      ...(typeof spec.country === "string" ? { country: spec.country } : {}),
    };

    const beforeRows = await gsc.loadMetricRows(
      organizationId,
      action.projectId,
      baselineWindow,
    );
    const afterRows = await gsc.loadMetricRows(
      organizationId,
      action.projectId,
      measurementWindow,
    );
    const comparisonRec = prePostComparison(
      beforeRows,
      afterRows,
      baselineWindow,
      measurementWindow,
      subject,
      { minImpressions: typeof spec.minImpressions === "number" ? spec.minImpressions : 0 },
    );
    const freshness = await gsc.metricFreshness(organizationId, action.projectId);

    return await reply.send({
      actionId: action.id,
      state: action.state,
      gate: action.verificationGate,
      subject,
      baselineWindow,
      measurementWindow,
      comparison: comparisonRec,
      verification: action.verification,
      freshness,
    });
  });
}

function windowFromIso(startsAt: string | undefined, endsAt: string | undefined): MetricWindow {
  const now = new Date();
  const end =
    endsAt && Number.isFinite(Date.parse(endsAt))
      ? new Date(endsAt).toISOString().slice(0, 10)
      : now.toISOString().slice(0, 10);
  const start =
    startsAt && Number.isFinite(Date.parse(startsAt))
      ? new Date(startsAt).toISOString().slice(0, 10)
      : new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  return { startDate: start, endDate: end };
}

interface ModuleInput {
  current: MetricRow[];
  baseline: MetricRow[];
  window: MetricWindow;
  baselineWindow: MetricWindow;
}

/** Run one module or every module. Empty rows legitimately yield empty output. */
function runModules(module: string | undefined, input: ModuleInput): MeasuredRecommendation[] {
  const { current, baseline, window, baselineWindow } = input;
  const run = (name: string): MeasuredRecommendation[] => {
    switch (name) {
      case "high_impressions_low_ctr":
        return highImpressionsLowCtr(current, window);
      case "ranking_opportunity":
        return rankingOpportunityWindows(current, window);
      case "page_query_decay":
        return pageQueryDecay(current, baseline, window, baselineWindow);
      case "query_cannibalization":
        return queryCannibalization(current, window);
      case "emerging_queries":
        return emergingQueries(current, baseline, window, baselineWindow);
      case "winners_losers":
        return winnersLosers(current, baseline, window, baselineWindow);
      case "page_query_intersections":
        return pageQueryIntersections(current, window);
      default:
        return [];
    }
  };
  if (module && module !== "all") {
    if (module === "pre_post_comparison") return [];
    return run(module);
  }
  return [
    ...run("high_impressions_low_ctr"),
    ...run("ranking_opportunity"),
    ...run("page_query_decay"),
    ...run("query_cannibalization"),
    ...run("emerging_queries"),
    ...run("winners_losers"),
    ...run("page_query_intersections"),
  ];
}
