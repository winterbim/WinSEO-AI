// /dashboard/[projectId]/search-performance/queries — the query breakdown.
// Every row is a dimension key Google actually returned, aggregated with
// impression-weighted position and a derived CTR.

import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import type { GscBreakdown } from "@/lib/types";
import { defaultWindow, windowQuery } from "@/lib/gsc";
import {
  BlockedCard,
  EmptyCard,
  FreshnessLine,
  GscSubNav,
  fmtCtr,
  fmtInt,
  fmtPosition,
} from "../shared";

export const dynamic = "force-dynamic";

export default async function GscQueriesPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const window = defaultWindow();

  let breakdown: GscBreakdown;
  try {
    breakdown = await apiFetch<GscBreakdown>(
      `/v1/projects/${projectId}/gsc/breakdown?${windowQuery(window, { dimension: "query", limit: "100" })}`,
    );
  } catch (err) {
    if (err instanceof ApiError && (err.status === 501 || err.status === 503)) {
      return (
        <div className="space-y-6">
          <h1 className="text-2xl font-bold">Queries</h1>
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Queries</h1>
          <p className="mt-1 text-sm text-slate-700">
            Search terms measured by Google Search Console in the dataset window.
          </p>
          <div className="mt-2">
            <GscSubNav projectId={projectId} current="/queries" />
          </div>
        </div>
      </div>

      <FreshnessLine freshness={breakdown.freshness} window={breakdown.window} />

      {breakdown.rows.length === 0 ? (
        <EmptyCard text="No measured query rows in this window. Nothing is filled in from other sources." />
      ) : (
        <section className="rounded-lg border border-line bg-panel p-5">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Clicks, impressions, CTR and position per query</caption>
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-slate-700">
                  <th scope="col" className="py-2 pr-4">
                    Query
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right">
                    Clicks
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right">
                    Impressions
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right">
                    CTR
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right">
                    Avg. position
                  </th>
                  <th scope="col" className="py-2 text-right">
                    Days
                  </th>
                </tr>
              </thead>
              <tbody>
                {breakdown.rows.map((row) => (
                  <tr key={row.key} className="border-b border-line/60">
                    <td className="py-2 pr-4">{row.key}</td>
                    <td className="py-2 pr-4 text-right font-mono">{fmtInt(row.clicks)}</td>
                    <td className="py-2 pr-4 text-right font-mono">{fmtInt(row.impressions)}</td>
                    <td className="py-2 pr-4 text-right font-mono">{fmtCtr(row.ctr)}</td>
                    <td className="py-2 pr-4 text-right font-mono">{fmtPosition(row.position)}</td>
                    <td className="py-2 text-right font-mono">{row.days}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-slate-700">
            {breakdown.totalGroups} quer{breakdown.totalGroups === 1 ? "y" : "ies"} from{" "}
            {fmtInt(breakdown.sourceRows)} measured rows.
          </p>
        </section>
      )}
    </div>
  );
}
