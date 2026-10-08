// Shared server components for the Search Performance surfaces.
// Everything renders persisted GSC rows or says plainly that none exist —
// there is no synthetic fallback anywhere in this folder.

import Link from "next/link";
import type { GscFreshness, GscMeasuredRecommendation, GscWindow } from "@/lib/types";
import { fmtCtr, fmtDate, fmtDateTime, fmtInt, fmtPosition } from "@/lib/gsc";
import { PromoteFindingButton } from "./promote-finding-button";

const TABS = [
  { slug: "", label: "Performance" },
  { slug: "/queries", label: "Queries" },
  { slug: "/pages", label: "Pages" },
  { slug: "/opportunities", label: "Opportunities" },
  { slug: "/changes", label: "Changes" },
] as const;

export function GscSubNav({ projectId, current }: { projectId: string; current: string }) {
  return (
    <nav aria-label="Search Performance" className="flex flex-wrap gap-4 text-sm">
      {TABS.map((tab) => (
        <Link
          key={tab.label}
          href={`/dashboard/${projectId}/search-performance${tab.slug}`}
          className={
            tab.slug === current
              ? "text-primary underline underline-offset-2"
              : "text-slate-700 hover:text-ink-950"
          }
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

export function FreshnessLine({
  freshness,
  window,
}: {
  freshness: GscFreshness;
  window?: GscWindow;
}) {
  return (
    <p className="text-xs text-slate-700">
      {window && (
        <>
          Dataset window{" "}
          <span className="font-mono">
            {fmtDate(window.startDate)} → {fmtDate(window.endDate)}
          </span>{" "}
          ·{" "}
        </>
      )}
      latest measured day <span className="font-mono">{fmtDate(freshness.latestMetricDate)}</span> ·
      last sync {fmtDateTime(freshness.lastSyncAt)} · {fmtInt(freshness.totalRows)} rows
    </p>
  );
}

export function BlockedCard({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-warning bg-panel p-8 text-center">
      <p className="font-semibold">BLOCKED — Google Search Console is not connected</p>
      <p className="mt-2 text-sm text-slate-700">{message}</p>
      <p className="mt-2 text-xs text-slate-700">
        No metrics are synthesized while blocked: every number on these pages must come from Google
        Search Console rows ingested for this project.
      </p>
    </div>
  );
}

export function EmptyCard({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-panel p-8 text-center">
      <p className="text-sm text-slate-700">{text}</p>
    </div>
  );
}

function gate(g: GscMeasuredRecommendation["verificationGate"]): string {
  const s = g.spec;
  const scope = [s.query ? `query="${s.query}"` : "", s.page ? `page=${s.page}` : ""]
    .filter(Boolean)
    .join(" ");
  return `${g.type}: ${s.metric} ${s.operator === "gte" ? "≥" : "≤"} ${s.threshold} over ${s.windowDays}d, min ${fmtInt(s.minImpressions)} impressions${scope ? ` (${scope})` : ""}`;
}

export function RecommendationCard({
  projectId,
  recommendation: rec,
  sourceFilters,
}: {
  projectId: string;
  recommendation: GscMeasuredRecommendation;
  sourceFilters: Record<string, string>;
}) {
  const window = rec.comparisonWindow
    ? {
        startDate: rec.comparisonWindow.startDate,
        endDate: rec.comparisonWindow.endDate,
      }
    : undefined;
  return (
    <article className="rounded-lg border border-line bg-panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-verified/10 px-2 py-0.5 text-xs font-medium text-verified">
            MEASURED
          </span>
          <span className="rounded bg-slate-700/10 px-2 py-0.5 text-xs font-medium text-slate-700">
            {rec.severity}
          </span>
          <span className="font-mono text-xs text-slate-700">{rec.module}</span>
        </div>
        <PromoteFindingButton
          projectId={projectId}
          recommendation={rec}
          sourceFilters={sourceFilters}
        />
      </div>
      <h3 className="mt-3 font-semibold">{rec.title}</h3>
      <p className="mt-1 text-sm text-slate-700">{rec.rationale}</p>

      <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
        <div>
          <dt className="uppercase tracking-wide text-slate-700">Dataset window</dt>
          <dd className="font-mono">
            {fmtDate(rec.datasetWindow.startDate)} → {fmtDate(rec.datasetWindow.endDate)}
          </dd>
        </div>
        {window && (
          <div>
            <dt className="uppercase tracking-wide text-slate-700">Comparison window</dt>
            <dd className="font-mono">
              {fmtDate(window.startDate)} → {fmtDate(window.endDate)}
            </dd>
          </div>
        )}
        <div>
          <dt className="uppercase tracking-wide text-slate-700">Rule thresholds</dt>
          <dd className="break-all font-mono">{JSON.stringify(rec.filters)}</dd>
        </div>
        <div>
          <dt className="uppercase tracking-wide text-slate-700">Dataset filters</dt>
          <dd className="break-all font-mono">{JSON.stringify(sourceFilters)}</dd>
        </div>
        <div>
          <dt className="uppercase tracking-wide text-slate-700">Verification gate</dt>
          <dd className="break-words">{gate(rec.verificationGate)}</dd>
        </div>
        <div>
          <dt className="uppercase tracking-wide text-slate-700">Observed</dt>
          <dd className="break-all font-mono">{JSON.stringify(rec.observed)}</dd>
        </div>
        {rec.baseline && (
          <div>
            <dt className="uppercase tracking-wide text-slate-700">Baseline</dt>
            <dd className="break-all font-mono">{JSON.stringify(rec.baseline)}</dd>
          </div>
        )}
        {rec.delta && (
          <div>
            <dt className="uppercase tracking-wide text-slate-700">Delta</dt>
            <dd className="break-all font-mono">{JSON.stringify(rec.delta)}</dd>
          </div>
        )}
      </dl>
    </article>
  );
}

export function MetricTable({
  rows,
  label,
}: {
  rows: { date: string; clicks: number; impressions: number; ctr: number; position: number }[];
  label: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr className="border-b border-line text-xs uppercase tracking-wide text-slate-700">
            <th scope="col" className="py-2 pr-4">
              Date
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
            <th scope="col" className="py-2 text-right">
              Avg. position
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.date} className="border-b border-line/60">
              <td className="py-2 pr-4 font-mono">{fmtDate(row.date)}</td>
              <td className="py-2 pr-4 text-right font-mono">{fmtInt(row.clicks)}</td>
              <td className="py-2 pr-4 text-right font-mono">{fmtInt(row.impressions)}</td>
              <td className="py-2 pr-4 text-right font-mono">{fmtCtr(row.ctr)}</td>
              <td className="py-2 text-right font-mono">{fmtPosition(row.position)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export { fmtCtr, fmtDate, fmtDateTime, fmtInt, fmtPosition };
