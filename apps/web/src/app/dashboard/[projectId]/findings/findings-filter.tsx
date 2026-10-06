"use client";

// Client-side filter/search over the server-fetched findings rows.
// All data is real (rendered by the server first); this component only narrows
// what is already on screen — it never fabricates rows.

import { useMemo, useState } from "react";
import Link from "next/link";
import type { FindingSummary } from "@/lib/types";
import { EPISTEMIC_STYLES, SEVERITY_STYLES } from "@/lib/types";

export function FindingsTable({
  projectId,
  findings,
}: {
  projectId: string;
  findings: FindingSummary[];
}) {
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState("");
  const [epistemic, setEpistemic] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(false);

  const severities = useMemo(
    () => [...new Set(findings.map((f) => f.severity))].sort(),
    [findings],
  );
  const classes = useMemo(
    () => [...new Set(findings.map((f) => f.epistemicClass))].sort(),
    [findings],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return findings.filter((f) => {
      if (severity && f.severity !== severity) return false;
      if (epistemic && f.epistemicClass !== epistemic) return false;
      if (onlyOpen && f.status !== "open") return false;
      if (!q) return true;
      return (
        f.title.toLowerCase().includes(q) ||
        f.ruleId.toLowerCase().includes(q) ||
        f.affectedUrls.some((u) => u.toLowerCase().includes(q))
      );
    });
  }, [findings, query, severity, epistemic, onlyOpen]);

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 border-b border-line pb-4">
        <div className="min-w-48 flex-1">
          <label htmlFor="findings-search" className="block text-xs font-medium text-slate-700">
            Search
          </label>
          <input
            id="findings-search"
            type="search"
            value={query}
            onChange={(e) => { setQuery(e.target.value); }}
            placeholder="Title, rule id or URL…"
            className="mt-1 w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div>
          <label htmlFor="filter-severity" className="block text-xs font-medium text-slate-700">
            Severity
          </label>
          <select
            id="filter-severity"
            value={severity}
            onChange={(e) => { setSeverity(e.target.value); }}
            className="mt-1 rounded-lg border border-line bg-panel px-3 py-2 text-sm focus:border-primary focus:outline-none"
          >
            <option value="">All</option>
            {severities.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="filter-class" className="block text-xs font-medium text-slate-700">
            Evidence class
          </label>
          <select
            id="filter-class"
            value={epistemic}
            onChange={(e) => { setEpistemic(e.target.value); }}
            className="mt-1 rounded-lg border border-line bg-panel px-3 py-2 text-sm focus:border-primary focus:outline-none"
          >
            <option value="">All</option>
            {classes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={onlyOpen}
            onChange={(e) => { setOnlyOpen(e.target.checked); }}
            className="size-4 accent-primary"
          />
          Open only
        </label>
      </div>

      <p className="mt-3 text-sm text-slate-700" role="status" aria-live="polite">
        Showing {filtered.length} of {findings.length} findings
      </p>

      {filtered.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-line bg-panel p-6 text-center text-sm text-slate-700">
          No findings match the current filters.
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">
              Findings with severity, evidence class, rule provenance and action state
            </caption>
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-slate-700">
                <th scope="col" className="py-2 pr-4">Finding</th>
                <th scope="col" className="py-2 pr-4">Severity</th>
                <th scope="col" className="py-2 pr-4">Evidence</th>
                <th scope="col" className="py-2 pr-4">Rule / version</th>
                <th scope="col" className="py-2 pr-4">Affected URL</th>
                <th scope="col" className="py-2 pr-4">Action</th>
                <th scope="col" className="py-2">First seen</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((f) => (
                <tr key={f.id} className="border-b border-line/60 align-top">
                  <td className="py-3 pr-4">
                    <Link
                      href={`/dashboard/${projectId}/findings/${f.id}`}
                      className="font-medium text-ink-950 hover:text-primary"
                    >
                      {f.title}
                    </Link>
                  </td>
                  <td className="py-3 pr-4">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[f.severity] ?? ""}`}
                    >
                      {f.severity}
                    </span>
                  </td>
                  <td className="py-3 pr-4">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${EPISTEMIC_STYLES[f.epistemicClass] ?? ""}`}
                    >
                      {f.epistemicClass}
                    </span>
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs text-slate-700">
                    {f.ruleId}
                    <br />v{f.ruleVersion}
                  </td>
                  <td className="max-w-56 truncate py-3 pr-4 font-mono text-xs text-slate-700">
                    {f.affectedUrls[0] ?? "—"}
                  </td>
                  <td className="py-3 pr-4 text-xs">{f.actionState ?? "—"}</td>
                  <td className="whitespace-nowrap py-3 text-xs text-slate-700">
                    {new Date(f.firstSeenAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}