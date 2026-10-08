import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import { defaultWindow, fmtDateTime, windowQuery } from "@/lib/gsc";
import { buildDecisionCenter } from "@/lib/decision-center";
import {
  aiVisibilityReportState,
  gscReportState,
  type AiVisibilityReportResponse,
} from "@/lib/report-data";
import type {
  ActionItem,
  FindingSummary,
  GscIntelligence,
  GscSummary,
  Overview,
} from "@/lib/types";
import { PrintReportButton } from "./print-button";

export const dynamic = "force-dynamic";

function display(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
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

  let aiVisibility: AiVisibilityReportResponse | null = null;
  let aiVisibilityUnavailable = false;
  try {
    aiVisibility = await apiFetch<AiVisibilityReportResponse>(
      `/v1/projects/${projectId}/ai-visibility/imports?includeStats=true&limit=5`,
    );
  } catch {
    aiVisibilityUnavailable = true;
  }

  const center = buildDecisionCenter(projectId, findings, intelligence?.recommendations ?? []);
  const openFindings = findings.filter((finding) => finding.status === "open");
  const verifiedActions = actions.filter((action) => action.state === "VERIFIED").length;
  const searchState = gscReportState(search, searchUnavailable !== null);
  const aiVisibilityState = aiVisibilityReportState(aiVisibility, aiVisibilityUnavailable);
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
        {searchState === "not-connected" ? (
          <p className="mt-3 rounded border border-line p-4 text-sm text-slate-700">
            No unique connected Search Console property is available for this project.
          </p>
        ) : searchState === "unavailable" ? (
          <p className="mt-3 rounded border border-line p-4 text-sm text-slate-700">
            Search Console data unavailable{searchUnavailable ? `: ${searchUnavailable}` : ""}
          </p>
        ) : searchState === "incomplete" ? (
          <p className="mt-3 rounded border border-line p-4 text-sm text-slate-700">
            Search Console sync does not cover the entire requested window. Metrics are withheld;
            missing dates are not treated as zero.
          </p>
        ) : searchState === "no-rows" ? (
          <p className="mt-3 rounded border border-line p-4 text-sm text-slate-700">
            No Search Analytics rows were returned for this locally synchronized window. This does
            not mean each metric was measured as zero.
          </p>
        ) : (
          <>
            <p className="mt-2 text-xs text-slate-700">
              Property: <span className="font-mono">{search?.property}</span> · locally synced
              window {window.startDate}–{window.endDate}
            </p>
            <dl className="mt-4 grid gap-3 sm:grid-cols-4">
              <Summary label="Clicks" value={display(search?.totals?.clicks)} />
              <Summary label="Impressions" value={display(search?.totals?.impressions)} />
              <Summary
                label="CTR"
                value={
                  (search?.totals?.impressions ?? 0) > 0
                    ? `${((search?.totals?.ctr ?? 0) * 100).toFixed(2)}%`
                    : "—"
                }
              />
              <Summary
                label="Average position"
                value={
                  (search?.totals?.impressions ?? 0) > 0 ? display(search?.totals?.position) : "—"
                }
              />
            </dl>
            <p className="mt-2 text-xs text-slate-700">
              Search Console freshness: {fmtDateTime(search?.freshness.lastSyncAt)}
            </p>
            <p className="mt-2 text-xs text-slate-700">
              These metrics are the rows returned by Search Console. Its API may omit rows and does
              not guarantee a complete dataset, especially for detailed page/query dimensions.
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
        {aiVisibilityState === "unavailable" ? (
          <p className="mt-2 rounded border border-line p-4 text-sm text-slate-700">
            AI Visibility history could not be loaded. This report does not interpret an API error
            as an empty history.
          </p>
        ) : aiVisibilityState === "empty" ? (
          <p className="mt-2 text-sm text-slate-700">
            No AI Visibility CSV imports have been recorded for this project.
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm leading-6 text-slate-700">
              These are persisted, user-supplied CSV captures. WinSEO has not verified them against
              an AI provider. Prompt panel completeness is unknown; a matching prompt ID does not
              prove that prompt wording stayed the same between imports. Wilson intervals describe
              the imported counts only and do not verify capture authenticity.
            </p>
            <ul className="mt-4 space-y-4">
              {aiVisibility?.imports.map((batch) => (
                <li key={batch.id} className="rounded border border-line p-4">
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700">
                    <span>
                      {batch.provenance} · {batch.epistemicClass}
                    </span>
                    <span>Provider verification: not verified</span>
                    <span>Imported {fmtDateTime(batch.createdAt)}</span>
                    <span>{batch.rowCount} persisted rows</span>
                  </div>
                  <p className="mt-2 break-all font-mono text-xs text-slate-700">
                    CSV SHA-256: {batch.csvSha256}
                  </p>
                  {batch.stats.length === 0 ? (
                    <p className="mt-3 text-sm text-slate-700">
                      This import has no aggregated prompt rows.
                    </p>
                  ) : (
                    <div className="mt-3 overflow-x-auto">
                      <table className="w-full min-w-[720px] text-left text-sm">
                        <caption className="sr-only">
                          Imported AI visibility counts and Wilson intervals by engine and prompt
                        </caption>
                        <thead>
                          <tr className="border-b border-line text-xs text-slate-700">
                            <th scope="col" className="py-2 pr-3">
                              Engine
                            </th>
                            <th scope="col" className="py-2 pr-3">
                              Prompt ID
                            </th>
                            <th scope="col" className="py-2 pr-3">
                              Mentions
                            </th>
                            <th scope="col" className="py-2 pr-3">
                              Citations
                            </th>
                            <th scope="col" className="py-2 pr-3">
                              Citation domains
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {batch.stats.map((stat) => (
                            <tr
                              key={`${stat.engine}:${stat.promptId}`}
                              className="border-b border-line/60 align-top"
                            >
                              <th scope="row" className="py-2 pr-3 font-medium">
                                {stat.engine}
                              </th>
                              <td className="py-2 pr-3">{stat.promptId}</td>
                              <td className="py-2 pr-3">
                                {stat.mentionCount}/{stat.runs} (
                                {(stat.mentionRate * 100).toFixed(1)}%)
                                <span className="block text-xs text-slate-700">
                                  Wilson 95%: {(stat.mentionWilson95[0] * 100).toFixed(1)}–
                                  {(stat.mentionWilson95[1] * 100).toFixed(1)}%
                                </span>
                              </td>
                              <td className="py-2 pr-3">
                                {stat.citationCount}/{stat.runs} (
                                {(stat.citationRate * 100).toFixed(1)}%)
                                <span className="block text-xs text-slate-700">
                                  Wilson 95%: {(stat.citationWilson95[0] * 100).toFixed(1)}–
                                  {(stat.citationWilson95[1] * 100).toFixed(1)}%
                                </span>
                              </td>
                              <td className="py-2 pr-3">
                                {stat.uniqueCitationDomains}
                                {stat.topCitationDomains.length > 0 && (
                                  <span className="block text-xs text-slate-700">
                                    {stat.topCitationDomains
                                      .map(([domain, count]) => `${domain} (${count})`)
                                      .join(", ")}
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-slate-700">
              Showing at most five recent imports. Expected panel denominator:{" "}
              {aiVisibility?.dataAvailability.promptPanelCompleteness}. Batches are shown
              separately; no cross-batch prompt or causal comparison is inferred.
            </p>
          </>
        )}
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
