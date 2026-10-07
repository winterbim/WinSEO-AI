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

const promotionSelectorSchema = z.object({
  module: z.enum([
    "high_impressions_low_ctr",
    "ranking_opportunity",
    "page_query_decay",
    "query_cannibalization",
    "emerging_queries",
    "winners_losers",
    "page_query_intersections",
  ]),
  subject: z.object({
    query: z.string().max(500).optional(),
    page: z.string().max(2000).optional(),
    device: z.string().max(16).optional(),
    country: z.string().max(8).optional(),
    property: z.string().max(500).optional(),
  }),
  sourceFilters: z
    .object({
      query: z.string().max(500).optional(),
      page: z.string().max(2000).optional(),
      device: z.enum(["DESKTOP", "MOBILE", "TABLET"]).optional(),
      country: z.string().max(8).optional(),
    })
    .optional(),
  datasetWindow: z.object({ startDate: isoDate, endDate: isoDate }),
  comparisonWindow: z.object({ startDate: isoDate, endDate: isoDate }).optional(),
});

const BASELINE_MODULES = new Set(["page_query_decay", "emerging_queries", "winners_losers"]);

type Filters = z.infer<typeof filtersQuery>;

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

function windowError(window: { startDate: string; endDate: string }): string | null {
  const start = Date.parse(`${window.startDate}T00:00:00Z`);
  const end = Date.parse(`${window.endDate}T00:00:00Z`);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    new Date(start).toISOString().slice(0, 10) !== window.startDate ||
    new Date(end).toISOString().slice(0, 10) !== window.endDate
  ) {
    return "Malformed date.";
  }
  if (end < start) return "endDate must not precede startDate.";
  if ((end - start) / 86_400_000 > 366) return "Window exceeds 366 days.";
  return null;
}

function nextIsoDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function hasCompletedWindowCoverage(
  jobs: Awaited<ReturnType<GscStore["listJobs"]>>,
  window: { startDate: string; endDate: string },
  connectionId: string,
): boolean {
  let nextUncoveredDate = window.startDate;
  const completed = jobs
    .filter((job) => job.status === "COMPLETED")
    .filter((job) => job.connectionId === connectionId)
    .filter((job) => job.windowEnd >= window.startDate && job.windowStart <= window.endDate)
    .sort((a, b) => a.windowStart.localeCompare(b.windowStart));

  for (const job of completed) {
    if (job.windowStart > nextUncoveredDate) return false;
    if (job.windowEnd >= window.endDate) return true;
    if (job.windowEnd >= nextUncoveredDate) nextUncoveredDate = nextIsoDate(job.windowEnd);
  }
  return false;
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

/** Preserve dataset-level device/country scope in both the claim and its gate. */
function bindRecommendationScope(
  recommendations: MeasuredRecommendation[],
  filters: ReturnType<typeof toFilters>,
  property: { id: string; externalProperty: string },
): MeasuredRecommendation[] {
  return recommendations.map((recommendation) => {
    const subject = {
      ...recommendation.subject,
      ...(filters.device ? { device: filters.device } : {}),
      ...(filters.country ? { country: filters.country } : {}),
      property: property.externalProperty,
    };
    return {
      ...recommendation,
      subject,
      verificationGate: {
        ...recommendation.verificationGate,
        spec: {
          ...recommendation.verificationGate.spec,
          ...(filters.device ? { device: filters.device } : {}),
          ...(filters.country ? { country: filters.country } : {}),
          connectionId: property.id,
        },
      },
    };
  });
}

async function connectedProperty(
  gsc: GscStore,
  organizationId: string,
  projectId: string,
): Promise<{ id: string; externalProperty: string } | null> {
  const connections = await gsc.listConnections(organizationId, projectId);
  const active = connections.filter((connection) => connection.status === "CONNECTED");
  if (active.length !== 1) return null;
  const connection = active[0];
  return connection ? { id: connection.id, externalProperty: connection.externalProperty } : null;
}

const NO_CONNECTED_PROPERTY = "00000000-0000-0000-0000-000000000000";

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
    const property = await connectedProperty(gsc, organizationId, project.id);
    const measurementFilters = {
      ...toFilters(query.data),
      connectionId: property?.id ?? NO_CONNECTED_PROPERTY,
    };
    const series = await gsc.metricSeries(organizationId, project.id, window, measurementFilters);
    const clicks = series.reduce((sum, p) => sum + p.clicks, 0);
    const impressions = series.reduce((sum, p) => sum + p.impressions, 0);
    const weightedPosition = series.reduce((sum, p) => sum + p.position * p.impressions, 0);
    const freshness = await gsc.metricFreshness(
      organizationId,
      project.id,
      property?.id ?? NO_CONNECTED_PROPERTY,
    );

    return await reply.send({
      window,
      filters: toFilters(query.data),
      property: property?.externalProperty ?? null,
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
    const property = await connectedProperty(gsc, organizationId, project.id);
    const rows = await gsc.loadMetricRows(organizationId, project.id, window, {
      ...toFilters(query.data),
      connectionId: property?.id ?? NO_CONNECTED_PROPERTY,
    });
    const limit = query.data.limit ? Math.min(Number(query.data.limit), 1000) : 100;
    const grouped = summarizeByDimension(rows, query.data.dimension).slice(0, limit);
    const freshness = await gsc.metricFreshness(
      organizationId,
      project.id,
      property?.id ?? NO_CONNECTED_PROPERTY,
    );

    return await reply.send({
      window,
      filters: toFilters(query.data),
      property: property?.externalProperty ?? null,
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
    const baseline = deriveBaselineWindow(window, query.data.baselineStart, query.data.baselineEnd);
    const filters = toFilters(query.data);
    const property = await connectedProperty(gsc, organizationId, project.id);
    if (!property) {
      return await sendError(
        reply,
        409,
        "GSC_PROPERTY_NOT_CONNECTED",
        "Connect exactly one Search Console property to this project before measuring recommendations.",
      );
    }
    const measurementFilters = { ...filters, connectionId: property.id };
    const needsBaseline =
      !query.data.module ||
      ["page_query_decay", "emerging_queries", "winners_losers", "pre_post_comparison"].includes(
        query.data.module,
      );
    if (needsBaseline) {
      const invalidBaseline = windowError(baseline);
      if (invalidBaseline) {
        return await sendError(reply, 400, "INVALID_COMPARISON_WINDOW", invalidBaseline);
      }
    }
    const jobs = await gsc.listJobs(organizationId, project.id);
    if (!hasCompletedWindowCoverage(jobs, window, property.id)) {
      return await sendError(
        reply,
        409,
        "MEASUREMENT_WINDOW_NOT_SYNCED",
        "The requested Search Console window is not completely synchronized. Sync it before using its measurements.",
      );
    }
    if (needsBaseline && !hasCompletedWindowCoverage(jobs, baseline, property.id)) {
      return await sendError(
        reply,
        409,
        "COMPARISON_WINDOW_NOT_SYNCED",
        "The comparison window is not completely synchronized. Missing data is not evidence of zero impressions; sync it before comparing periods.",
      );
    }
    const current = await gsc.loadMetricRows(
      organizationId,
      project.id,
      window,
      measurementFilters,
    );
    const baselineRows = needsBaseline
      ? await gsc.loadMetricRows(organizationId, project.id, baseline, measurementFilters)
      : [];

    const recommendations = bindRecommendationScope(
      runModules(query.data.module, {
        current,
        baseline: baselineRows,
        window,
        baselineWindow: baseline,
      }),
      filters,
      property,
    );
    const freshness = await gsc.metricFreshness(organizationId, project.id, property.id);

    return await reply.send({
      module: query.data.module ?? "all",
      window,
      comparisonWindow: baseline,
      filters,
      property: property.externalProperty,
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

  // ─── Promote a recommendation after recomputing it from persisted GSC rows ───
  app.post("/projects/:projectId/gsc/findings", async (request, reply) => {
    const organizationId = activeOrg(request, reply);
    if (!organizationId) return;
    if (!requirePermission(request, reply, "action.approve")) return;
    const gsc = requireStore(reply);
    if (!gsc) return;

    const params = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (!params.success) return await sendError(reply, 404, "NOT_FOUND", "Project not found.");
    const body = promotionSelectorSchema.safeParse(request.body);
    if (!body.success) {
      return await sendError(
        reply,
        400,
        "VALIDATION_ERROR",
        "A recommendation module, subject, and measured date window are required.",
      );
    }
    const project = await requireProject(organizationId, params.data.projectId, reply);
    if (!project) return;

    const property = await connectedProperty(gsc, organizationId, project.id);
    if (!property) {
      return await sendError(
        reply,
        409,
        "GSC_PROPERTY_NOT_CONNECTED",
        "Connect exactly one Search Console property to this project before promoting a recommendation.",
      );
    }

    const window = body.data.datasetWindow;
    const invalidWindow = windowError(window);
    if (invalidWindow) {
      return await sendError(reply, 400, "INVALID_WINDOW", invalidWindow);
    }
    const needsBaseline = BASELINE_MODULES.has(body.data.module);
    if (needsBaseline && !body.data.comparisonWindow) {
      return await sendError(
        reply,
        400,
        "INVALID_COMPARISON_WINDOW",
        "This recommendation requires its measured comparison window.",
      );
    }
    const baselineWindow =
      body.data.comparisonWindow ?? deriveBaselineWindow(window, undefined, undefined);
    if (body.data.comparisonWindow) {
      const invalidBaseline = windowError(body.data.comparisonWindow);
      if (invalidBaseline) {
        return await sendError(reply, 400, "INVALID_COMPARISON_WINDOW", invalidBaseline);
      }
    }

    const jobs = await gsc.listJobs(organizationId, project.id);
    if (!hasCompletedWindowCoverage(jobs, window, property.id)) {
      return await sendError(
        reply,
        409,
        "MEASUREMENT_WINDOW_NOT_SYNCED",
        "The current Search Console window has not been completely synchronized. Sync it, then refresh the analysis.",
      );
    }
    if (needsBaseline && !hasCompletedWindowCoverage(jobs, baselineWindow, property.id)) {
      return await sendError(
        reply,
        409,
        "COMPARISON_WINDOW_NOT_SYNCED",
        "The comparison window has not been completely synchronized. Its absence cannot be treated as zero; sync it, then refresh the analysis.",
      );
    }

    const sourceFilters = body.data.sourceFilters ?? {};
    const measurementFilters = { ...sourceFilters, connectionId: property.id };
    const sourceProperty = {
      connectionId: property.id,
      externalProperty: property.externalProperty,
    };
    const current = await gsc.loadMetricRows(
      organizationId,
      project.id,
      window,
      measurementFilters,
    );
    const baseline = needsBaseline
      ? await gsc.loadMetricRows(organizationId, project.id, baselineWindow, measurementFilters)
      : [];
    const candidates = bindRecommendationScope(
      runModules(body.data.module, {
        current,
        baseline,
        window,
        baselineWindow,
      }),
      sourceFilters,
      property,
    );
    const subjectKey = (subject: MeasuredRecommendation["subject"]) =>
      JSON.stringify(Object.entries(subject).sort(([a], [b]) => a.localeCompare(b)));
    const rec = candidates.find(
      (candidate) => subjectKey(candidate.subject) === subjectKey(body.data.subject),
    );
    if (!rec) {
      return await sendError(
        reply,
        409,
        "MEASUREMENT_STALE",
        "This recommendation is no longer present in the project's persisted Search Console data. Refresh the analysis and try again.",
      );
    }

    const canonicalMetricRows = (rows: Awaited<ReturnType<GscStore["loadMetricRows"]>>) =>
      rows
        .map((row) => ({
          date: row.date,
          query: row.query,
          page: row.page,
          country: row.country,
          device: row.device,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const sourceRows = {
      current: canonicalMetricRows(current),
      baseline: canonicalMetricRows(baseline),
    };
    const measurementSource = {
      sha256: createHash("sha256")
        .update(JSON.stringify({ sourceProperty, sourceRows }))
        .digest("hex"),
      sourceProperty,
      currentRowCount: sourceRows.current.length,
      baselineRowCount: sourceRows.baseline.length,
    };

    const ruleId = recommendationRuleId(rec);
    const affectedUrl = rec.subject.page ?? `https://${project.primaryDomain}`;

    // Canonical server-derived payload → hash. Nothing claimed by the browser
    // about title, rationale, observed values, severity, or gate is persisted.
    const canonical = JSON.stringify({
      module: rec.module,
      subject: rec.subject,
      sourceProperty,
      datasetWindow: rec.datasetWindow,
      sourceFilters,
      filters: rec.filters,
      comparisonWindow: rec.comparisonWindow ?? null,
      baseline: rec.baseline ?? null,
      delta: rec.delta ?? null,
      measurementSource,
      observed: rec.observed,
      evidenceClass: rec.evidenceClass,
      verificationGate: rec.verificationGate,
    });
    const contentHash = createHash("sha256").update(canonical).digest("hex");

    const workflow = await app.stores.crawl.createMeasuredGscWorkflow(
      organizationId,
      project.id,
      {
        ruleId,
        ruleVersion: "1.0.0",
        title: rec.title,
        epistemicClass: "MEASURED",
        severity: rec.severity,
        explanation: rec.rationale,
        recommendation: rec.title,
        affectedUrls: [affectedUrl],
        verificationGate: rec.verificationGate.type,
      },
      {
        kind: "gsc_data",
        sourceRef: `gsc://search-analytics?start=${rec.datasetWindow.startDate}&end=${rec.datasetWindow.endDate}&rule=${encodeURIComponent(ruleId)}`,
        contentHash,
        objectKey: `${organizationId}/${project.id}/gsc_data/${contentHash}`,
        metadata: {
          evidenceClass: rec.evidenceClass,
          module: rec.module,
          subject: rec.subject,
          datasetWindow: rec.datasetWindow,
          sourceFilters,
          sourceProperty,
          filters: rec.filters,
          comparisonWindow: rec.comparisonWindow ?? null,
          measurementSource,
          observed: rec.observed,
          baseline: rec.baseline ?? null,
          delta: rec.delta ?? null,
          verificationGate: rec.verificationGate,
          rationale: rec.rationale,
        },
      },
    );

    if (!workflow.created) {
      return await reply.send({
        created: false,
        updated: workflow.updated,
        findingId: workflow.findingId,
        evidenceId: workflow.evidenceId,
        actionId: workflow.actionId,
        ruleId,
        contentHash,
        reason: workflow.updated
          ? "the open finding was refreshed with current measured evidence"
          : "an equivalent measured finding is already open",
      });
    }

    return await reply.status(201).send({
      created: true,
      updated: false,
      findingId: workflow.findingId,
      evidenceId: workflow.evidenceId,
      actionId: workflow.actionId,
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
    const connectionId = z.uuid().safeParse(spec.connectionId);
    if (!connectionId.success) {
      return await sendError(
        reply,
        409,
        "GSC_PROPERTY_UNKNOWN",
        "This legacy action has no verified Search Console property attached to its measurement gate.",
      );
    }
    const property = await gsc.getConnection(organizationId, connectionId.data);
    if (property?.projectId !== action.projectId) {
      return await sendError(reply, 404, "NOT_FOUND", "Action not found.");
    }

    const comparison = action.comparisonWindow as { startsAt?: string; endsAt?: string } | null;
    const measurementWindow = windowFromIso(comparison?.startsAt, comparison?.endsAt);
    const baselineWindow = deriveBaselineWindow(measurementWindow, undefined, undefined);
    const subject = {
      ...(typeof spec.query === "string" ? { query: spec.query } : {}),
      ...(typeof spec.page === "string" ? { page: spec.page } : {}),
      ...(typeof spec.device === "string" ? { device: spec.device } : {}),
      ...(typeof spec.country === "string" ? { country: spec.country } : {}),
      ...(typeof spec.property === "string" ? { property: spec.property } : {}),
    };

    const measurementFilters = {
      ...(typeof spec.query === "string" ? { query: spec.query } : {}),
      ...(typeof spec.page === "string" ? { page: spec.page } : {}),
      ...(typeof spec.device === "string" ? { device: spec.device } : {}),
      ...(typeof spec.country === "string" ? { country: spec.country } : {}),
      connectionId: connectionId.data,
    };
    const beforeRows = await gsc.loadMetricRows(
      organizationId,
      action.projectId,
      baselineWindow,
      measurementFilters,
    );
    const afterRows = await gsc.loadMetricRows(
      organizationId,
      action.projectId,
      measurementWindow,
      measurementFilters,
    );
    const comparisonRec = prePostComparison(
      beforeRows,
      afterRows,
      baselineWindow,
      measurementWindow,
      subject,
      { minImpressions: typeof spec.minImpressions === "number" ? spec.minImpressions : 0 },
    );
    const freshness = await gsc.metricFreshness(
      organizationId,
      action.projectId,
      connectionId.data,
    );

    return await reply.send({
      actionId: action.id,
      state: action.state,
      gate: action.verificationGate,
      subject,
      property: property.externalProperty,
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
