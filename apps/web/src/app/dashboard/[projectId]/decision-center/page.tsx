import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import type { FindingSummary, GscIntelligence } from "@/lib/types";
import { EPISTEMIC_STYLES, SEVERITY_STYLES } from "@/lib/types";
import { defaultWindow, windowQuery } from "@/lib/gsc";
import { buildDecisionCenter, type DecisionLane } from "@/lib/decision-center";

export const dynamic = "force-dynamic";

const LANE_META: Record<DecisionLane, { title: string; description: string }> = {
  FIX_NOW: {
    title: "Fix now",
    description: "Observed defects with enough severity to deserve immediate attention.",
  },
  GROW: {
    title: "Grow",
    description: "Measured opportunities where visibility or demand already exists.",
  },
  REFRESH: {
    title: "Refresh",
    description: "Measured decline or weakening performance that merits a content review.",
  },
  CONSOLIDATE_REVIEW: {
    title: "Consolidate review",
    description:
      "Possible cannibalization. Review intent overlap before merging, redirecting, or deleting anything.",
  },
  WATCH: {
    title: "Watch",
    description: "Lower-risk observations worth monitoring, not automatic intervention.",
  },
};

const LANE_ORDER: DecisionLane[] = ["FIX_NOW", "GROW", "REFRESH", "CONSOLIDATE_REVIEW", "WATCH"];

export default async function DecisionCenterPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const findings = (
    await apiFetch<{ findings: FindingSummary[] }>(`/v1/projects/${projectId}/findings`)
  ).findings;

  const window = defaultWindow();
  let recommendations: GscIntelligence["recommendations"] = [];
  let gscAvailable = true;
  try {
    const intelligence = await apiFetch<GscIntelligence>(
      `/v1/projects/${projectId}/gsc/intelligence?${windowQuery(window)}`,
    );
    recommendations = intelligence.recommendations;
  } catch (error) {
    if (error instanceof ApiError && [404, 501, 503].includes(error.status)) {
      gscAvailable = false;
    } else {
      throw error;
    }
  }

  const center = buildDecisionCenter(projectId, findings, recommendations);

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-slate-700">
            Evidence → decision → verification
          </p>
          <h1 className="mt-1 text-2xl font-bold">Decision Center</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-700">
            One queue built from two evidence classes: directly observed crawl facts and measured
            Search Console performance. WinSEO does not collapse them into a synthetic SEO score.
          </p>
        </div>
        <nav className="flex flex-wrap gap-3 text-sm" aria-label="Decision Center">
          <Link href={`/dashboard/${projectId}`} className="text-primary underline">
            Overview
          </Link>
          <Link
            href={`/dashboard/${projectId}/search-performance`}
            className="text-slate-700 hover:text-ink-950"
          >
            Search Performance
          </Link>
          <Link
            href={`/dashboard/${projectId}/ai-visibility`}
            className="text-slate-700 hover:text-ink-950"
          >
            AI Visibility
          </Link>
        </nav>
      </div>

      {!gscAvailable && (
        <section className="rounded-lg border border-dashed border-warning bg-panel p-4">
          <p className="font-medium">Search Console data is not available yet.</p>
          <p className="mt-1 text-sm text-slate-700">
            The queue below still contains observed crawl facts. Measured growth, refresh, and
            consolidation signals appear only after Search Console is connected and synchronized.
          </p>
        </section>
      )}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-label="Decision lanes">
        {LANE_ORDER.map((lane) => (
          <div key={lane} className="rounded-lg border border-line bg-panel p-4">
            <p className="text-xs uppercase tracking-wide text-slate-700">
              {LANE_META[lane].title}
            </p>
            <p className="mt-1 font-mono text-2xl font-bold">{center.counts[lane]}</p>
          </div>
        ))}
      </section>

      {center.items.length === 0 ? (
        <section className="rounded-lg border border-dashed border-line bg-panel p-8 text-center">
          <h2 className="font-semibold">No decision is ready yet</h2>
          <p className="mt-2 text-sm text-slate-700">
            Run a crawl and connect Search Console. WinSEO will keep this page empty rather than
            invent work.
          </p>
        </section>
      ) : (
        LANE_ORDER.map((lane) => {
          const items = center.items.filter((item) => item.lane === lane);
          if (items.length === 0) return null;
          const meta = LANE_META[lane];

          return (
            <section key={lane} className="space-y-3" aria-labelledby={`lane-${lane}`}>
              <div>
                <h2 id={`lane-${lane}`} className="text-lg font-semibold">
                  {meta.title}
                </h2>
                <p className="text-sm text-slate-700">{meta.description}</p>
              </div>

              <div className="grid gap-3">
                {items.map((item) => (
                  <article key={item.id} className="rounded-lg border border-line bg-panel p-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-medium ${
                          EPISTEMIC_STYLES[item.evidenceClass] ?? "bg-slate-700/10 text-slate-700"
                        }`}
                      >
                        {item.evidenceClass}
                      </span>
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-medium ${
                          SEVERITY_STYLES[item.severity] ?? "bg-slate-700/10 text-slate-700"
                        }`}
                      >
                        {item.severity}
                      </span>
                      <span className="text-xs uppercase tracking-wide text-slate-700">
                        {item.source}
                      </span>
                    </div>
                    <h3 className="mt-3 font-semibold">{item.title}</h3>
                    <p className="mt-1 text-sm leading-6 text-slate-700">{item.reason}</p>
                    {item.affectedUrls[0] && (
                      <p className="mt-3 break-all font-mono text-xs text-slate-700">
                        {item.affectedUrls[0]}
                      </p>
                    )}
                    <Link
                      href={item.href}
                      className="mt-4 inline-block text-sm font-medium text-primary underline underline-offset-2"
                    >
                      Open evidence
                    </Link>
                  </article>
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
