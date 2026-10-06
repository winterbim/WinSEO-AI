// /dashboard/[projectId] — project overview answering the four questions
// (Blueprint §4.3) from PERSISTED rows only:
//   1. What changed?          → latest finding + crawl timeline
//   2. Why does it matter?    → severity/epistemic breakdown (counts, no score)
//   3. What should I do now?  → top open findings with recommendations + gates
//   4. Did my interventions work? → honest empty state until real verifications exist

import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import type { FindingSummary, Overview } from "@/lib/types";
import { EPISTEMIC_STYLES, SEVERITY_STYLES } from "@/lib/types";
import { StartCrawlButton } from "./start-crawl-button";

export const dynamic = "force-dynamic";

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  let overview: Overview;
  let findings: FindingSummary[] = [];
  try {
    overview = await apiFetch<Overview>(`/v1/projects/${projectId}/overview`);
    findings = (
      await apiFetch<{ findings: FindingSummary[] }>(`/v1/projects/${projectId}/findings`)
    ).findings;
  } catch (err) {
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

  const openFindings = findings.filter((f) => f.status === "open").slice(0, 5);
  const severityEntries = Object.entries(overview.findings.bySeverity);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{overview.project.name}</h1>
          <p className="mt-1 font-mono text-sm text-slate-700">{overview.project.primaryDomain}</p>
          <nav aria-label="Project" className="mt-2 flex gap-4 text-sm">
            <Link
              href={`/dashboard/${projectId}`}
              className="text-primary underline underline-offset-2"
            >
              Overview
            </Link>
            <Link
              href={`/dashboard/${projectId}/findings`}
              className="text-slate-700 hover:text-ink-950"
            >
              Findings
            </Link>
            <Link
              href={`/dashboard/${projectId}/actions`}
              className="text-slate-700 hover:text-ink-950"
            >
              Actions
            </Link>
            <Link
              href={`/dashboard/${projectId}/autofix`}
              className="text-slate-700 hover:text-ink-950"
            >
              Proven patches
            </Link>
            <Link
              href={`/dashboard/${projectId}/search-performance`}
              className="text-slate-700 hover:text-ink-950"
            >
              Search Performance
            </Link>
            <Link
              href={`/dashboard/${projectId}/crawls`}
              className="text-slate-700 hover:text-ink-950"
            >
              Crawl history
            </Link>
          </nav>
        </div>
        <StartCrawlButton projectId={projectId} />
      </div>

      {/* ── Q1: What changed? ── */}
      <section aria-labelledby="q1" className="rounded-lg border border-line bg-panel p-6">
        <h2 id="q1" className="text-lg font-semibold">
          What changed?
        </h2>
        {overview.findings.latest ? (
          <div className="mt-3">
            <p className="text-sm text-slate-700">Most recent finding:</p>
            <Link
              href={`/dashboard/${projectId}/findings/${overview.findings.latest.id}`}
              className="mt-1 block font-medium text-primary underline underline-offset-2"
            >
              {overview.findings.latest.title}
            </Link>
            <p className="mt-1 text-xs text-slate-700">
              <span className="font-mono">{overview.findings.latest.ruleId}</span> · first seen{" "}
              {fmt(overview.findings.latest.firstSeenAt)}
            </p>
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-700">
            No findings recorded yet — run a crawl to build the baseline.
          </p>
        )}
        <p className="mt-4 text-xs text-slate-700">
          {overview.crawls.total} crawl{overview.crawls.total === 1 ? "" : "s"} ·{" "}
          {overview.evidence.total} evidence item{overview.evidence.total === 1 ? "" : "s"} · last
          crawl {fmt(overview.crawls.latest?.startedAt)}
        </p>
      </section>

      {/* ── Q2: Why does it matter? ── */}
      <section aria-labelledby="q2" className="rounded-lg border border-line bg-panel p-6">
        <h2 id="q2" className="text-lg font-semibold">
          Why does it matter?
        </h2>
        <p className="mt-1 text-sm text-slate-700">
          {overview.findings.total} verified issue
          {overview.findings.total === 1 ? "" : "s"} — every one is an <strong>OBSERVED</strong>{" "}
          fact of the fetched document, not an estimate of any ranking effect. No global SEO score
          is computed.
        </p>
        {severityEntries.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-2">
            {severityEntries.map(([sev, count]) => (
              <li
                key={sev}
                className={`rounded px-2 py-1 text-xs font-medium ${SEVERITY_STYLES[sev] ?? "bg-slate-700/10 text-slate-700"}`}
              >
                {sev}: {count} of {overview.findings.total}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-700">Nothing detected yet.</p>
        )}
      </section>

      {/* ── Q3: What should I do now? ── */}
      <section aria-labelledby="q3" className="rounded-lg border border-line bg-panel p-6">
        <h2 id="q3" className="text-lg font-semibold">
          What should I do now?
        </h2>
        {openFindings.length === 0 ? (
          <p className="mt-2 text-sm text-slate-700">
            No open findings. Run a crawl, or re-crawl after your next change.
          </p>
        ) : (
          <ol className="mt-3 space-y-4">
            {openFindings.map((f) => (
              <li key={f.id} className="border-l-2 border-line pl-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[f.severity] ?? ""}`}
                  >
                    {f.severity}
                  </span>
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${EPISTEMIC_STYLES[f.epistemicClass] ?? ""}`}
                  >
                    {f.epistemicClass}
                  </span>
                  <span className="font-mono text-xs text-slate-700">{f.ruleId}</span>
                </div>
                <Link
                  href={`/dashboard/${projectId}/findings/${f.id}`}
                  className="mt-1 block font-medium text-ink-950 hover:text-primary"
                >
                  {f.title}
                </Link>
                {f.recommendation && (
                  <p className="mt-1 text-sm text-slate-700">{f.recommendation}</p>
                )}
                <p className="mt-1 text-xs text-slate-700">
                  Gate: <span className="font-mono">{f.verificationGate}</span> ·{" "}
                  {f.affectedUrls[0] ?? "scope unknown"}
                </p>
              </li>
            ))}
          </ol>
        )}
        {overview.findings.total > openFindings.length && (
          <Link
            href={`/dashboard/${projectId}/findings`}
            className="mt-4 inline-block text-sm text-primary underline underline-offset-2"
          >
            View all {overview.findings.total} findings
          </Link>
        )}
      </section>

      {/* ── Q4: Did previous interventions work? ── */}
      <section aria-labelledby="q4" className="rounded-lg border border-line bg-panel p-6">
        <h2 id="q4" className="text-lg font-semibold">
          Did my previous interventions work?
        </h2>
        <p className="mt-2 text-sm text-slate-700">{overview.interventions.note}</p>
        <p className="mt-1 text-xs text-slate-700">
          A change counts as verified only after its declared verification gate runs and returns
          evidence — deployment success alone is not an outcome.
        </p>
      </section>

      {/* Freshness — Blueprint API contract */}
      <p className="text-xs text-slate-700">
        Data freshness: {fmt(overview.dataFreshness)} · method v{overview.methodVersion}
      </p>
    </div>
  );
}
