// /dashboard/[projectId]/search-performance/changes — winners, losers, decay
// and emerging queries across the comparison window. Deltas are computed by
// deterministic arithmetic over the two measured windows and shown with both
// windows spelled out.

import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import type { GscIntelligence, GscMeasuredRecommendation } from "@/lib/types";
import { defaultWindow, windowQuery } from "@/lib/gsc";
import { BlockedCard, EmptyCard, FreshnessLine, GscSubNav, RecommendationCard } from "../shared";

export const dynamic = "force-dynamic";

const CHANGE_MODULES = new Set(["winners_losers", "page_query_decay", "emerging_queries"]);

export default async function GscChangesPage({
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
          <h1 className="text-2xl font-bold">Changes</h1>
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

  const changes: GscMeasuredRecommendation[] = intelligence.recommendations.filter((r) =>
    CHANGE_MODULES.has(r.module),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Changes</h1>
          <p className="mt-1 text-sm text-slate-700">
            Winners, losers, decay and emerging queries between the comparison window and the
            dataset window — both measured, both shown.
          </p>
          <div className="mt-2">
            <GscSubNav projectId={projectId} current="/changes" />
          </div>
        </div>
      </div>

      <FreshnessLine freshness={intelligence.freshness} window={intelligence.window} />
      <p className="text-xs text-slate-700">
        Comparison window{" "}
        <span className="font-mono">
          {intelligence.comparisonWindow.startDate} → {intelligence.comparisonWindow.endDate}
        </span>
      </p>

      {changes.length === 0 ? (
        <EmptyCard text="No change module found a movement above its materiality threshold between the two windows." />
      ) : (
        <div className="grid gap-4">
          {changes.map((rec) => (
            <RecommendationCard
              key={`${rec.module}:${JSON.stringify(rec.subject)}`}
              projectId={projectId}
              recommendation={rec}
              sourceFilters={intelligence.filters}
            />
          ))}
        </div>
      )}
    </div>
  );
}
