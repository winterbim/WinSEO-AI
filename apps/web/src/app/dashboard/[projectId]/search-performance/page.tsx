// /dashboard/[projectId]/search-performance — Search Performance overview.
// SSR over persisted gsc_query_metrics rows only: totals, the daily series,
// connection/sync state and freshness. When Google is not connected the page
// says BLOCKED — it never renders synthesized numbers.

import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import type { GscConnection, GscJob, GscSummary } from "@/lib/types";
import { defaultWindow, windowQuery } from "@/lib/gsc";
import { GscConnectButton, GscSyncButton } from "./gsc-controls";
import {
  BlockedCard,
  EmptyCard,
  FreshnessLine,
  GscSubNav,
  MetricTable,
  fmtCtr,
  fmtDate,
  fmtDateTime,
  fmtInt,
  fmtPosition,
} from "./shared";

export const dynamic = "force-dynamic";

export default async function SearchPerformancePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const window = defaultWindow();

  let summary: GscSummary;
  let jobs: GscJob[] = [];
  let connections: GscConnection[] = [];
  try {
    summary = await apiFetch<GscSummary>(
      `/v1/projects/${projectId}/gsc/summary?${windowQuery(window)}`,
    );
    const jobRes = await apiFetch<{ jobs: GscJob[]; connections: GscConnection[] }>(
      `/v1/projects/${projectId}/gsc/jobs`,
    );
    jobs = jobRes.jobs;
    connections = jobRes.connections;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 501 || err.status === 503)) {
      return (
        <div className="space-y-6">
          <h1 className="text-2xl font-bold">Search Performance</h1>
          <BlockedCard message={err.message} />
        </div>
      );
    }
    if (err instanceof ApiError && err.status === 404) {
      return (
        <div className="rounded-lg border border-line bg-panel p-6">
          <h1 className="text-lg font-semibold">Project not found</h1>
          <p className="mt-1 text-sm text-slate-700">
            It does not exist in this workspace, or it belongs to another organization.
          </p>
          <Link href="/dashboard" className="mt-3 inline-block text-sm text-primary underline">
            Back to your sites
          </Link>
        </div>
      );
    }
    throw err;
  }

  const connected = connections.find((c) => c.status === "CONNECTED");
  const hasData =
    summary.syncCoverage === "SYNCED" && summary.series.length > 0 && summary.totals !== null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Search Performance</h1>
          <p className="mt-1 text-sm text-slate-700">
            First-party Google Search Console measurements — clicks, impressions, CTR and average
            position exactly as Google reported them. Nothing on this page is estimated.
          </p>
          <div className="mt-2">
            <GscSubNav projectId={projectId} current="" />
          </div>
        </div>
        {connected ? (
          <GscSyncButton projectId={projectId} connectionId={connected.id} />
        ) : (
          <GscConnectButton projectId={projectId} />
        )}
      </div>

      <section className="rounded-lg border border-line bg-panel p-5" aria-label="Connection">
        <h2 className="font-semibold">Connection</h2>
        {connections.length === 0 ? (
          <p className="mt-2 text-sm text-slate-700">
            No Google Search Console property is connected to this project yet.
          </p>
        ) : (
          <ul className="mt-3 grid gap-2 text-sm">
            {connections.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{c.externalProperty}</span>
                <span
                  className={`rounded px-2 py-0.5 text-xs font-medium ${c.status === "CONNECTED" ? "bg-verified/10 text-verified" : "bg-slate-700/10 text-slate-700"}`}
                >
                  {c.status}
                </span>
                <span className="text-xs text-slate-700">
                  last sync {fmtDateTime(c.lastSyncAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3">
          <FreshnessLine freshness={summary.freshness} window={summary.window} />
        </div>
      </section>

      {summary.syncCoverage === "INCOMPLETE" ? (
        <EmptyCard text="The Search Console sync does not cover this entire window. Metrics are withheld; sync the missing dates before using them." />
      ) : summary.syncCoverage === "NO_UNIQUE_PROPERTY" ? (
        <EmptyCard text="Connect exactly one Search Console property to measure this project. No metrics are shown until a property is connected." />
      ) : !hasData || !summary.totals ? (
        <EmptyCard text="No Search Analytics rows were returned for this fully synchronized window. That is not evidence that each metric was zero." />
      ) : (
        <>
          <section aria-label="Totals" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "Clicks", value: fmtInt(summary.totals.clicks) },
              { label: "Impressions", value: fmtInt(summary.totals.impressions) },
              { label: "CTR", value: fmtCtr(summary.totals.ctr) },
              { label: "Avg. position", value: fmtPosition(summary.totals.position) },
            ].map((card) => (
              <div key={card.label} className="rounded-lg border border-line bg-panel p-5">
                <p className="text-xs uppercase tracking-wide text-slate-700">{card.label}</p>
                <p className="mt-1 font-mono text-2xl font-bold">{card.value}</p>
              </div>
            ))}
          </section>

          <section className="rounded-lg border border-line bg-panel p-5" aria-label="Daily series">
            <h2 className="font-semibold">Daily performance</h2>
            <p className="mt-1 text-sm text-slate-700">
              {summary.totals.days} measured day{summary.totals.days === 1 ? "" : "s"} in this
              window. Position is impression-weighted; CTR is derived from summed clicks and
              impressions.
            </p>
            <div className="mt-3">
              <MetricTable
                rows={summary.series}
                label="Daily clicks, impressions, CTR and average position"
              />
            </div>
          </section>
        </>
      )}

      {jobs.length > 0 && (
        <section
          className="rounded-lg border border-line bg-panel p-5"
          aria-label="Synchronization jobs"
        >
          <h2 className="font-semibold">Synchronization jobs</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-slate-700">
                  <th scope="col" className="py-2 pr-4">
                    Window
                  </th>
                  <th scope="col" className="py-2 pr-4">
                    Status
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right">
                    Rows
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right">
                    Attempt
                  </th>
                  <th scope="col" className="py-2">
                    Detail
                  </th>
                </tr>
              </thead>
              <tbody>
                {jobs.slice(0, 10).map((job) => (
                  <tr key={job.id} className="border-b border-line/60">
                    <td className="py-2 pr-4 font-mono">
                      {fmtDate(job.windowStart)} → {fmtDate(job.windowEnd)}
                    </td>
                    <td className="py-2 pr-4">{job.status}</td>
                    <td className="py-2 pr-4 text-right font-mono">{fmtInt(job.rowCount)}</td>
                    <td className="py-2 pr-4 text-right font-mono">{job.attempt}</td>
                    <td className="py-2 text-xs text-slate-700">
                      {job.errorCode ? `${job.errorCode}: ${job.errorMessage ?? ""}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
