// /dashboard/[projectId]/findings/[findingId] — full evidence-backed detail:
// claim, classification, provenance (rule/version), scope (affected URL),
// recommendation, declared verification gate, action state and the linked
// evidence items (content hash + source reference).

import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import type { FindingDetail } from "@/lib/types";
import { EPISTEMIC_STYLES, SEVERITY_STYLES } from "@/lib/types";

export const dynamic = "force-dynamic";

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default async function FindingDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; findingId: string }>;
}) {
  const { projectId, findingId } = await params;

  let finding: FindingDetail;
  try {
    const res = await apiFetch<{ finding: FindingDetail }>(`/v1/findings/${findingId}`);
    finding = res.finding;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return (
        <div className="rounded-lg border border-line bg-panel p-6">
          <h1 className="text-lg font-semibold">Finding not found</h1>
          <p className="mt-1 text-sm text-slate-700">
            It does not exist in this workspace, or it belongs to another organization.
          </p>
          <Link
            href={`/dashboard/${projectId}/findings`}
            className="mt-3 inline-block text-sm text-primary underline"
          >
            ← Back to findings
          </Link>
        </div>
      );
    }
    throw err;
  }

  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <Link
        href={`/dashboard/${projectId}/findings`}
        className="inline-block text-sm text-primary underline underline-offset-2"
      >
        ← Back to findings
      </Link>

      {/* Claim */}
      <header className="rounded-lg border border-line bg-panel p-6">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[finding.severity] ?? ""}`}
          >
            {finding.severity}
          </span>
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${EPISTEMIC_STYLES[finding.epistemicClass] ?? ""}`}
          >
            {finding.epistemicClass}
          </span>
          <span className="rounded bg-ink-950 px-2 py-0.5 text-xs font-medium text-white">
            {finding.status}
          </span>
        </div>
        <h1 className="mt-3 text-2xl font-bold">{finding.title}</h1>
        <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-700">Rule provenance</dt>
            <dd className="font-mono">
              {finding.ruleId} v{finding.ruleVersion}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-700">First seen</dt>
            <dd>{fmt(finding.firstSeenAt)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-700">Affected URL</dt>
            <dd className="break-all font-mono text-xs">
              {finding.affectedUrls.length > 0 ? finding.affectedUrls.join(", ") : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-700">Action state</dt>
            <dd>{finding.actionState ?? "—"}</dd>
          </div>
        </dl>
      </header>

      {finding.actionState && (
        <Link
          href={`/dashboard/${projectId}/actions`}
          className="inline-block rounded bg-primary px-4 py-2 text-sm font-medium text-white"
        >
          Open in Action Center
        </Link>
      )}

      {/* Why it matters */}
      <section aria-labelledby="why" className="rounded-lg border border-line bg-panel p-6">
        <h2 id="why" className="text-lg font-semibold">
          What was observed
        </h2>
        <p className="mt-2 text-sm text-slate-700">{finding.explanation}</p>
        <p className="mt-3 text-xs text-slate-700">
          Classification <strong>{finding.epistemicClass}</strong> means this is what the fetched
          data directly shows — no ranking effect is claimed.
        </p>
      </section>

      {/* Recommendation + gate */}
      <section aria-labelledby="todo" className="rounded-lg border border-line bg-panel p-6">
        <h2 id="todo" className="text-lg font-semibold">
          Recommended intervention
        </h2>
        {finding.recommendation ? (
          <p className="mt-2 text-sm text-slate-700">{finding.recommendation}</p>
        ) : (
          <p className="mt-2 text-sm text-slate-700">No recommendation attached to this rule.</p>
        )}
        <div className="mt-4 rounded bg-surface p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-700">
            Verification gate
          </p>
          <p className="mt-1 font-mono text-sm">{finding.verificationGate}</p>
          <p className="mt-1 text-xs text-slate-700">
            The fix counts as verified only when this gate re-runs and the rule no longer fires —
            not when the change is merely deployed.
          </p>
        </div>
      </section>

      {/* Evidence */}
      <section aria-labelledby="evidence" className="rounded-lg border border-line bg-panel p-6">
        <h2 id="evidence" className="text-lg font-semibold">
          Evidence ({finding.evidence.length})
        </h2>
        {finding.evidence.length === 0 ? (
          <p className="mt-2 text-sm text-slate-700">No evidence linked to this finding yet.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {finding.evidence.map((e) => (
              <li key={e.id} className="rounded border border-line bg-surface p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="rounded bg-ink-950 px-2 py-0.5 text-xs font-medium text-white">
                    {e.kind}
                  </span>
                  <span className="text-xs text-slate-700">{fmt(e.capturedAt)}</span>
                </div>
                <p className="mt-2 break-all font-mono text-xs text-slate-700">
                  source: {e.sourceRef}
                </p>
                <p className="break-all font-mono text-xs text-slate-700">
                  sha256: {e.contentHash}
                </p>
                {typeof e.metadata.summary === "string" && (
                  <p className="mt-2 text-xs text-slate-700">{e.metadata.summary}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
