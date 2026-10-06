// /dashboard/[projectId]/crawls — crawl history ("what changed over time").
// Real rows only: run id, mode, status, timing, pages crawled/failed.

import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import type { CrawlRun } from "@/lib/types";

export const dynamic = "force-dynamic";

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export default async function CrawlHistoryPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  let runs: CrawlRun[] = [];
  try {
    const res = await apiFetch<{ crawlRuns: CrawlRun[] }>(
      `/v1/projects/${projectId}/crawl-runs`,
    );
    runs = res.crawlRuns;
  } catch (err) {
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Crawl history</h1>
          <p className="mt-1 text-sm text-slate-700">
            Each run records when the site was observed and what was fetched — the
            baseline every later comparison depends on.
          </p>
        </div>
        <Link
          href={`/dashboard/${projectId}`}
          className="text-sm text-primary underline underline-offset-2"
        >
          ← Overview
        </Link>
      </div>

      {runs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line bg-panel p-8 text-center">
          <p className="font-medium">No crawls yet.</p>
          <p className="mt-1 text-sm text-slate-700">
            Run a crawl from the overview page to establish the first baseline.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">Crawl runs, newest first</caption>
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-slate-700">
                <th scope="col" className="py-2 pr-4">Run</th>
                <th scope="col" className="py-2 pr-4">Status</th>
                <th scope="col" className="py-2 pr-4">Mode</th>
                <th scope="col" className="py-2 pr-4">Started</th>
                <th scope="col" className="py-2 pr-4">Completed</th>
                <th scope="col" className="py-2 pr-4">Pages</th>
                <th scope="col" className="py-2">Failed</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-line/60">
                  <td className="max-w-40 truncate py-3 pr-4 font-mono text-xs">{r.id}</td>
                  <td className="py-3 pr-4">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${
                        r.status === "completed"
                          ? "bg-verified/10 text-verified"
                          : r.status === "failed"
                            ? "bg-critical/10 text-critical"
                            : "bg-warning/10 text-warning"
                      }`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs">{r.mode}</td>
                  <td className="whitespace-nowrap py-3 pr-4 text-xs text-slate-700">
                    {fmt(r.startedAt)}
                  </td>
                  <td className="whitespace-nowrap py-3 pr-4 text-xs text-slate-700">
                    {fmt(r.completedAt)}
                  </td>
                  <td className="py-3 pr-4">{r.pagesCrawled}</td>
                  <td className="py-3">{r.pagesFailed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}