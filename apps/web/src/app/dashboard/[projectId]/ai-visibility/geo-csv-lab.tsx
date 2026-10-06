"use client";

import { useMemo, useState } from "react";
import { computeGeoStats, parseGeoCsv, type GeoStats } from "@/lib/geo-stats";

const EXAMPLE = [
  "engine,prompt_id,brand_mentioned,client_cited,citation_domains",
  "ChatGPT,comparison-1,true,true,example.com;source.org",
  "Claude,comparison-1,false,false,source.org",
  "Perplexity,comparison-1,true,true,example.com",
].join("\n");

function pct(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

export function GeoCsvLab() {
  const [csv, setCsv] = useState("");
  const [stats, setStats] = useState<GeoStats | null>(null);
  const [error, setError] = useState("");

  const canAnalyze = useMemo(() => csv.trim().length > 0, [csv]);

  function analyze() {
    try {
      const rows = parseGeoCsv(csv);
      if (rows.length === 0) throw new Error("No capture rows found.");
      setStats(computeGeoStats(rows));
      setError("");
    } catch (err) {
      setStats(null);
      setError(err instanceof Error ? err.message : "Could not parse the CSV.");
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    setCsv(text);
    setStats(null);
    setError("");
  }

  function loadExample() {
    setCsv(EXAMPLE);
    setStats(null);
    setError("");
  }

  function downloadJson() {
    if (!stats) return;
    const blob = new Blob([JSON.stringify(stats, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "winseo-ai-visibility.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-line bg-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Import captured AI-answer samples</h2>
            <p className="mt-1 text-sm text-slate-700">
              Paste CSV or choose a file. The calculation runs in this browser.
              This lab does not call an AI provider or invent missing captures.
            </p>
          </div>
          <button
            type="button"
            onClick={loadExample}
            className="rounded border border-line px-3 py-2 text-sm hover:bg-slate-50"
          >
            Load example data
          </button>
        </div>

        <textarea
          value={csv}
          onChange={(event) => {
            setCsv(event.target.value);
            setStats(null);
            setError("");
          }}
          spellCheck={false}
          rows={9}
          className="mt-4 w-full rounded border border-line bg-white p-3 font-mono text-xs"
          placeholder="engine,prompt_id,brand_mentioned,client_cited,citation_domains"
          aria-label="AI visibility CSV"
        />

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="cursor-pointer rounded border border-line px-3 py-2 text-sm hover:bg-slate-50">
            Choose CSV
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(event) => void onFile(event.target.files?.[0])}
            />
          </label>
          <button
            type="button"
            disabled={!canAnalyze}
            onClick={analyze}
            className="rounded bg-ink-950 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Analyze samples
          </button>
          {error && <p className="text-sm text-critical">{error}</p>}
        </div>
      </section>

      {stats && (
        <>
          <section className="rounded-lg border border-warning/50 bg-panel p-4">
            <p className="text-sm font-medium">Measurement note</p>
            <p className="mt-1 text-sm text-slate-700">{stats.warning}</p>
            <p className="mt-1 text-xs text-slate-700">
              Sample rows: <span className="font-mono">{stats.inputRows}</span>
            </p>
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            {stats.engines.map((engine) => (
              <article key={engine.engine} className="rounded-lg border border-line bg-panel p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">{engine.engine}</h3>
                    <p className="mt-1 text-xs text-slate-700">
                      {engine.runs} captured run{engine.runs === 1 ? "" : "s"}
                    </p>
                  </div>
                  <span className="rounded bg-verified/10 px-2 py-1 text-xs font-medium text-verified">
                    MEASURED SAMPLE
                  </span>
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-4">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-slate-700">
                      Brand mention
                    </dt>
                    <dd className="mt-1 font-mono text-xl font-bold">
                      {pct(engine.mentionRate)}
                    </dd>
                    <dd className="text-xs text-slate-700">
                      95% Wilson {pct(engine.mentionWilson95[0])}–{pct(engine.mentionWilson95[1])}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-slate-700">
                      Client citation
                    </dt>
                    <dd className="mt-1 font-mono text-xl font-bold">
                      {pct(engine.citationRate)}
                    </dd>
                    <dd className="text-xs text-slate-700">
                      95% Wilson {pct(engine.citationWilson95[0])}–{pct(engine.citationWilson95[1])}
                    </dd>
                  </div>
                </dl>

                <div className="mt-4 border-t border-line pt-4">
                  <p className="text-xs uppercase tracking-wide text-slate-700">
                    Citation-domain diversity
                  </p>
                  <p className="mt-1 font-mono text-lg">
                    {engine.uniqueCitationDomains}
                  </p>
                  {engine.topCitationDomains.length > 0 && (
                    <ul className="mt-2 space-y-1 text-xs text-slate-700">
                      {engine.topCitationDomains.slice(0, 5).map(([domain, count]) => (
                        <li key={domain} className="flex justify-between gap-3">
                          <span>{domain}</span>
                          <span className="font-mono">{count}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </article>
            ))}
          </section>

          <button
            type="button"
            onClick={downloadJson}
            className="rounded border border-line px-3 py-2 text-sm hover:bg-slate-50"
          >
            Export JSON
          </button>
        </>
      )}
    </div>
  );
}
