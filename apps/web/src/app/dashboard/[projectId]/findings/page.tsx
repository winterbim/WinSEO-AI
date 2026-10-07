// /dashboard/[projectId]/findings — the Evidence Ledger table.
// Rows are server-rendered from PostgreSQL; filtering/search runs client-side
// over that real data (see findings-filter.tsx).

import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import type { FindingSummary } from "@/lib/types";
import { FindingsTable } from "./findings-filter";

export const dynamic = "force-dynamic";

export default async function FindingsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  let findings: FindingSummary[] = [];
  try {
    const res = await apiFetch<{ findings: FindingSummary[] }>(
      `/v1/projects/${projectId}/findings`,
    );
    findings = res.findings;
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
          <h1 className="text-2xl font-bold">Findings</h1>
          <p className="mt-1 text-sm text-slate-700">
            Every row is an observed fact of a fetched document, with rule provenance and a declared
            verification gate.
          </p>
        </div>
        <Link
          href={`/dashboard/${projectId}`}
          className="text-sm text-primary underline underline-offset-2"
        >
          ← Overview
        </Link>
      </div>

      {findings.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line bg-panel p-8 text-center">
          <p className="font-medium">No findings recorded yet.</p>
          <p className="mt-1 text-sm text-slate-700">
            Run a crawl from the overview page to build the first evidence-backed baseline.
          </p>
        </div>
      ) : (
        <FindingsTable projectId={projectId} findings={findings} />
      )}
    </div>
  );
}
