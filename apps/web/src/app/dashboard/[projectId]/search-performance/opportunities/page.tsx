// /dashboard/[projectId]/search-performance/opportunities — the opportunity
// modules of the deterministic engine: low-CTR visibility, ranking windows,
// cannibalization evidence and page/query intersections. Each card carries the
// exact dataset window, filters, observed values and the verification gate a
// later GSC remeasurement will re-run — MEASURED, never an LLM opinion.

import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import type { GscIntelligence, GscMeasuredRecommendation } from "@/lib/types";
import { defaultWindow, windowQuery } from "@/lib/gsc";
import { BlockedCard, EmptyCard, FreshnessLine, GscSubNav, RecommendationCard } from "../shared";

export const dynamic = "force-dynamic";

const OPPORTUNITY_MODULES = new Set([
  "high_impressions_low_ctr",
  "ranking_opportunity",
  "query_cannibalization",
  "page_query_intersections",
]);

export default async function GscOpportunitiesPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const window = defaultWindow();

  let intelligence: GscIntelligence;
  try {
    intelligence = await apiFetch<GscIntelligence>(
      `/v1/projects/${projectId}/gsc/intelligence?${windowQuery(window)}`,
    );
  } catch (err) {
    if (err instanceof ApiError && (err.status === 501 || err.status === 503)) {
      return (
        <div className="space-y-6">
          <h1 className="text-2xl font-bold">Opportunities</h1>
          <BlockedCard message={err.message} />
        </div>
      );
    }
    if (err instanceof ApiError && err.status === 404) {
      return (
        <div className="rounded-lg border border-line bg-panel p-6">
          <h1 className="text-lg font-semibold">Project not found</h1>
          <Link href="/dashboard" className="mt-3 inline-block text-sm text-primary underline">
            Back to your sites
          </Link>
        </div>
      );
    }
    throw err;
  }

  const opportunities: GscMeasuredRecommendation[] = intelligence.recommendations.filter((r) =>
    OPPORTUNITY_MODULES.has(r.module),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Opportunities</h1>
          <p className="mt-1 text-sm text-slate-700">
            Deterministic findings over measured Search Analytics rows. Every recommendation can
            be promoted into the Action Center, where its gate is re-measured after the change.
          </p>
          <div className="mt-2">
            <GscSubNav projectId={projectId} current="/opportunities" />
          </div>
        </div>
      </div>

      <FreshnessLine freshness={intelligence.freshness} window={intelligence.window} />

      {opportunities.length === 0 ? (
        <EmptyCard text="No opportunity module found evidence above its impression floor in this window. An empty input yields an empty output — that is the system working." />
      ) : (
        <div className="grid gap-4">
          {opportunities.map((rec) => (
            <RecommendationCard
              key={`${rec.module}:${JSON.stringify(rec.subject)}`}
              projectId={projectId}
              recommendation={rec}
            />
          ))}
        </div>
      )}
    </div>
  );
}
