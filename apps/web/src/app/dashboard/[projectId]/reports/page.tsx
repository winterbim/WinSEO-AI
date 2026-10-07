import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import { defaultWindow, fmtDateTime, windowQuery } from "@/lib/gsc";
import { buildDecisionCenter } from "@/lib/decision-center";
import type {
  ActionItem,
  FindingSummary,
  GscIntelligence,
  GscSummary,
  Overview,
} from "@/lib/types";
import { PrintReportButton } from "./print-button";

export const dynamic = "force-dynamic";

function display(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

export default async function ProjectReportPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const window = defaultWindow();
  const [overview, findingResponse, actionResponse] = await Promise.all([
    apiFetch<Overview>(`/v1/projects/${projectId}/overview`),
    apiFetch<{ findings: FindingSummary[] }>(`/v1/projects/${projectId}/findings`),
    apiFetch<{ actions: ActionItem[] }>(`/v1/projects/${projectId}/actions`),
  ]);
  const findings = findingResponse.findings;
  const actions = actionResponse.actions;

  let search: GscSummary | null = null;
  let searchUnavailable: string | null = null;
  try {
    search = await apiFetch<GscSummary>(
      `/v1/projects/${projectId}/gsc/summary?${windowQuery(window)}`,
    );
  } catch (error) {
    if (error instanceof ApiError && [409, 501, 503].includes(error.status)) {
      searchUnavailable = error.message;
    } else {
      throw error;
    }
  }
  let intelligence: GscIntelligence | null = null;
  try {
    intelligence = await apiFetch<GscIntelligence>(
      `/v1/projects/${projectId}/gsc/intelligence?${windowQuery(window)}`,
    );
  } catch (error) {
    if (!(error instanceof ApiError && [409, 501, 503].includes(error.status))) throw error;
  }

  const center = buildDecisionCenter(projectId, findings, intelligence?.recommendations ?? []);
  const openFindings = findings.filter((finding) => finding.status === "open");
  const verifiedActions = actions.filter((action) => action.state === "VERIFIED").length;
  const searchConnected = Boolean(search?.property);
  const capturedAt = new Date().toISOString();

  return (
    <article className="mx-auto max-w-5xl space-y-8 bg-white p-6 text-ink-950 print:max-w-none print:p-0">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-5">
        <div>
          <Link
            href={`/dashboard/${projectId}`}
            className="text-sm text-primary underline print:hidden"
          >
            ← Project overview
          </Link>
          <p className="mt-3 text-xs uppercase tracking-[0.16em] text-slate-700">WinSEO report</p>
          <h1 className="mt-1 text-3xl font-bold">{overview.project.name}</h1>
          <p className="mt-1 font-mono text-sm text-slate-700">{overview.project.primaryDomain}</p>
          <p className="mt-3 text-xs text-slate-700">
            Generated {fmtDateTime(capturedAt)} · Search window {window.startDate} to{" "}
            {window.endDate}
          </p>
        </div>
        <PrintReportButton />
      </header>

      <section aria-labelledby="executive-summary">
        <h2 id="executive-summary" className="text-xl font-semibold">
          Executive summary
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-700">
          This report summarizes persisted WinSEO observations and measurements. It does not
          estimate a search-engine score or claim that a change caused a traffic outcome.
        </p>
        <dl className="mt-4 grid gap-3 sm:grid-cols-3">
          <Summary label="Open technical findings" value={String(openFindings.length)} />
          <Summary label="Actions verified" value={String(verifiedActions)} />
          <Summary label="Evidence records" value={String(overview.evidence.total)} />
        </dl>
      </section>

      <section aria-labelledby="technical-findings">
        <h2 id="technical-findings" className="text-xl font-semibold">
          Technical findings
        </h2>
        {openFindings.length === 0 ? (
          <p className="mt-3 text-sm text-slate-700">
            No open crawl findings are currently recorded.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-line border-y border-line">
            {openFindings.map((finding) => {
              const findingAdvice = finding.recommendation ?? finding.explanation;
              return (
                <li key={finding.id} className="py-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-semibold uppercase">{finding.severity}</span>
                    <span>{finding.epistemicClass}</span>
                    <span className="font-mono">{finding.ruleId}</span>
                  </div>
                  <h3 className="mt-1 font-medium">{finding.title}</h3>
                  <p className="mt-1 text-sm text-slate-700">
                    {finding.affectedUrls.length
                      ? finding.affectedUrls.join(" · ")
                      : "URL scope unavailable"}
                  </p>
                  {findingAdvice && <p className="mt-1 text-sm text-slate-700">{findingAdvice}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="search-performance">
        <h2 id="search-performance" className="text-xl font-semibold">
          Search performance
        </h2>
        {!searchConnected ? (
          <p className="mt-3 rounded border border-line p-4 text-sm text-slate-700">
            {search?.property === null
              ? "Search Console data not connected"
              : searchUnavailable
                ? `Search Console data unavailable: ${searchUnavailable}`
                : "Search Console data unavailable for this window"}
          </p>
        ) : (
          <>
            <p className="mt-2 text-xs text-slate-700">
              Property: <span className="font-mono">{search?.property}</span> · window{" "}
              {window.startDate}–{window.endDate}
            </p>
            <dl className="mt-4 grid gap-3 sm:grid-cols-4">
              <Summary label="Clicks" value={display(search?.totals.clicks ?? 0)} />
              <Summary label="Impressions" value={display(search?.totals.impressions ?? 0)} />
              <Summary label="CTR" value={`${((search?.totals.ctr ?? 0) * 100).toFixed(2)}%`} />
              <Summary label="Average position" value={display(search?.totals.position ?? 0)} />
            </dl>
            <p className="mt-2 text-xs text-slate-700">
              Search Console freshness: {fmtDateTime(search?.freshness.lastSyncAt)}
            </p>
          </>
        )}
      </section>

      <section aria-labelledby="decisions">
        <h2 id="decisions" className="text-xl font-semibold">
          Decision Center
        </h2>
        {center.items.length === 0 ? (
          <p className="mt-3 text-sm text-slate-700">
            No current decision items are backed by persisted evidence.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {center.items.slice(0, 20).map((item) => (
              <li key={item.id} className="rounded border border-line p-3">
                <p className="text-xs font-semibold">
                  {item.lane} · {item.evidenceClass} · {item.severity}
                </p>
                <h3 className="mt-1 font-medium">{item.title}</h3>
                <p className="mt-1 text-sm text-slate-700">{item.reason}</p>
                <p className="mt-1 break-all text-xs text-slate-700">
                  {item.affectedUrls.length
                    ? item.affectedUrls.join(" · ")
                    : "No page URL attached"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="actions">
        <h2 id="actions" className="text-xl font-semibold">
          Actions and verified changes
        </h2>
        {actions.length === 0 ? (
          <p className="mt-3 text-sm text-slate-700">No actions are recorded.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {actions.map((action) => {
              const verdict =
                typeof action.verification?.verdict === "string"
                  ? action.verification.verdict
                  : null;
              return (
                <li key={action.id} className="rounded border border-line p-3">
                  <p className="text-xs font-semibold">
                    {action.state} · {action.severity}
                  </p>
                  <p className="mt-1 font-medium">{action.findingTitle}</p>
                  <p className="mt-1 text-sm text-slate-700">
                    {verdict ? `Verification: ${verdict}` : "No verified outcome recorded"}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="ai-visibility">
        <h2 id="ai-visibility" className="text-xl font-semibold">
          AI visibility
        </h2>
        <p className="mt-2 text-sm text-slate-700">
          No persisted AI visibility captures are available for this project. Browser-only CSV
          calculations and illustrative examples are excluded from this report.
        </p>
      </section>

      <footer className="border-t border-line pt-4 text-xs leading-5 text-slate-700">
        <h2 className="font-semibold">Methodology and freshness</h2>
        <p>
          Technical findings come from stored crawl observations. Search metrics, when connected,
          come from persisted Search Console rows for the stated window. AI-answer visibility is
          stochastic and requires repeated captures; no provider responses are invented. Missing
          integrations are reported as unavailable, not as zero performance.
        </p>
        <p className="mt-2">Last crawl: {fmtDateTime(overview.crawls.latest?.completedAt)}</p>
      </footer>
    </article>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-line p-3">
      <dt className="text-xs text-slate-700">{label}</dt>
      <dd className="mt-1 text-xl font-semibold">{value}</dd>
    </div>
  );
}
