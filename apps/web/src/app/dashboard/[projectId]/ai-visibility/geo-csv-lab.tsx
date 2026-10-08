"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AI_VISIBILITY_MAX_CSV_BYTES,
  computeAiVisibilityStats,
  parseAiVisibilityCsv,
  type AiVisibilityStat,
} from "@serpvera/contracts";

const EXAMPLE = [
  "engine,prompt_id,brand_mentioned,client_cited,citation_domains,sampled_at",
  "ChatGPT,comparison-1,true,true,example.com;source.org,2026-10-01T10:30:00Z",
  "Claude,comparison-1,false,false,source.org,2026-10-02T10:30:00Z",
  "Perplexity,comparison-1,true,true,example.com,2026-10-03T10:30:00Z",
].join("\n");

interface ImportRecord {
  id: string;
  csvSha256: string;
  rowCount: number;
  createdAt: string;
  provenance: "USER_SUPPLIED";
  epistemicClass: "DOCUMENTED";
  unverified_by_provider: true;
}

interface ImportDetail {
  import: ImportRecord;
  stats: AiVisibilityStat[];
  captures: {
    rowNumber: number;
    engine: string;
    promptId: string;
    brandMentioned: boolean;
    clientCited: boolean;
    citationDomains: string[];
    sampledAt: string;
  }[];
}

interface ApiErrorBody {
  error?: { message?: string };
}

interface StatsResponse {
  imports: ImportRecord[];
  stats: AiVisibilityStat[];
}

function pct(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

function changeLabel(current: number, previous: number | undefined): string {
  if (previous === undefined) return "Aucun lot précédent comparable";
  const delta = current - previous;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(delta)} vs lot précédent`;
}

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function responseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
  return body.error?.message ?? `Request failed (${response.status}).`;
}

export function GeoCsvLab({ projectId }: { projectId: string }) {
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<AiVisibilityStat[] | null>(null);
  const [illustrative, setIllustrative] = useState(false);
  const [imports, setImports] = useState<ImportRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<ImportDetail | null>(null);
  const [previous, setPrevious] = useState<ImportDetail | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const endpoint = `/api/v1/projects/${encodeURIComponent(projectId)}/ai-visibility/imports`;
  const canAnalyze = useMemo(() => csv.trim().length > 0, [csv]);
  const displayedSelection = selected?.import.id === selectedId ? selected : null;
  const displayedPrevious = displayedSelection ? previous : null;

  const loadHistory = useCallback(
    async (preferredId?: string, signal?: AbortSignal) => {
      const response = await fetch(endpoint, { cache: "no-store", signal });
      if (!response.ok) throw new Error(await responseError(response));
      const body = (await response.json()) as StatsResponse;
      if (signal?.aborted) return [];
      const rows = body.imports;
      setImports(rows);
      const nextId =
        preferredId && rows.some((item) => item.id === preferredId)
          ? preferredId
          : (rows[0]?.id ?? "");
      setSelectedId(nextId);
      return rows;
    },
    [endpoint],
  );

  const loadDetail = useCallback(
    async (importId: string, signal?: AbortSignal): Promise<ImportDetail> => {
      const response = await fetch(`${endpoint}/${encodeURIComponent(importId)}`, {
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error(await responseError(response));
      return (await response.json()) as ImportDetail;
    },
    [endpoint],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadHistory(undefined, controller.signal).catch((err: unknown) => {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : "Could not load saved captures.");
      }
    });
    return () => {
      controller.abort();
    };
  }, [loadHistory]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      setPrevious(null);
      return;
    }
    const controller = new AbortController();
    setSelected(null);
    setPrevious(null);
    setError("");
    const index = imports.findIndex((item) => item.id === selectedId);
    const previousId = index >= 0 ? imports[index + 1]?.id : undefined;
    void Promise.all([
      loadDetail(selectedId, controller.signal),
      previousId ? loadDetail(previousId, controller.signal) : Promise.resolve(null),
    ])
      .then(([current, prior]) => {
        if (controller.signal.aborted) return;
        setSelected(current);
        setPrevious(prior);
        setError("");
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setSelected(null);
          setPrevious(null);
          setError(err instanceof Error ? err.message : "Could not load saved capture details.");
        }
      });
    return () => {
      controller.abort();
    };
  }, [imports, loadDetail, selectedId]);

  function analyze() {
    try {
      const captures = parseAiVisibilityCsv(csv);
      setPreview(computeAiVisibilityStats(captures));
      setError("");
      setNotice(
        illustrative
          ? "Example data stays in this browser and cannot be saved."
          : "Preview calculated from the CSV in this browser.",
      );
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : "Could not parse the CSV.");
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setCsv("");
    setPreview(null);
    setIllustrative(false);
    setError("");
    setNotice("");
    if (file.size > AI_VISIBILITY_MAX_CSV_BYTES) {
      setError("CSV exceeds the 1 MiB import limit.");
      return;
    }
    try {
      setCsv(await file.text());
      setIllustrative(false);
      setPreview(null);
      setError("");
      setNotice(`Loaded ${file.name}. Review and analyze it before saving.`);
    } catch {
      setCsv("");
      setPreview(null);
      setError("Could not read this file. Choose a UTF-8 CSV file and try again.");
    }
  }

  function loadExample() {
    setCsv(EXAMPLE);
    setIllustrative(true);
    setPreview(null);
    setError("");
    setNotice("Illustrative rows only. This example is never saved as project data.");
  }

  async function saveCaptures() {
    if (!preview || illustrative) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const csvSha256 = await sha256(csv);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csvText: csv, csvSha256 }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const body = (await response.json()) as ImportDetail;
      setNotice(
        `Saved ${body.import.rowCount} user-supplied captures. Provider authenticity was not verified.`,
      );
      setPreview(null);
      setIllustrative(false);
      await loadHistory(body.import.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save captures.");
    } finally {
      setBusy(false);
    }
  }

  function exportSelected(current: ImportDetail, prior: ImportDetail | null) {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            import: current.import,
            captures: current.captures,
            stats: current.stats,
            comparison: prior ? { importId: prior.import.id, stats: prior.stats } : null,
            promptPanelCoverage: "UNKNOWN: no expected prompt-panel denominator was supplied.",
            warning:
              "User-supplied captures; provider authenticity is not independently verified. AI answers are stochastic.",
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "winseo-ai-visibility-import.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function renderStats(stats: AiVisibilityStat[], baseline: AiVisibilityStat[] = []) {
    if (stats.length === 0)
      return <p className="text-sm text-slate-700">No captures in this batch.</p>;
    return (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-line text-xs uppercase tracking-wide text-slate-700">
              <th className="py-3 pr-4">Engine / prompt ID</th>
              <th className="py-3 pr-4">Runs</th>
              <th className="py-3 pr-4">Brand mention</th>
              <th className="py-3 pr-4">Client citation</th>
              <th className="py-3 pr-4">Citation domains</th>
              <th className="py-3">Movement</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((stat) => {
              const prior = baseline.find(
                (row) => row.engine === stat.engine && row.promptId === stat.promptId,
              );
              const mentionBand = stat.mentionWilson95;
              const citationBand = stat.citationWilson95;
              return (
                <tr
                  key={`${stat.engine}:${stat.promptId}`}
                  className="border-b border-line align-top"
                >
                  <th scope="row" className="py-3 pr-4 font-medium">
                    <span className="block">{stat.engine}</span>
                    <span
                      className="mt-1 block max-w-52 truncate font-mono text-xs text-slate-700"
                      title={stat.promptId}
                    >
                      {stat.promptId}
                    </span>
                  </th>
                  <td className="py-3 pr-4 font-mono">{stat.runs}</td>
                  <td className="py-3 pr-4">
                    <span className="font-mono">{pct(stat.mentionRate)}</span>
                    <span className="mt-1 block text-xs text-slate-700">
                      95% Wilson {pct(mentionBand[0])}–{pct(mentionBand[1])}
                    </span>
                  </td>
                  <td className="py-3 pr-4">
                    <span className="font-mono">{pct(stat.citationRate)}</span>
                    <span className="mt-1 block text-xs text-slate-700">
                      95% Wilson {pct(citationBand[0])}–{pct(citationBand[1])}
                    </span>
                  </td>
                  <td className="py-3 pr-4">
                    <span className="font-mono">{stat.uniqueCitationDomains}</span>
                    {stat.topCitationDomains.length > 0 && (
                      <span
                        className="mt-1 block max-w-44 truncate text-xs text-slate-700"
                        title={stat.topCitationDomains.map(([domain]) => domain).join(", ")}
                      >
                        {stat.topCitationDomains
                          .slice(0, 3)
                          .map(([domain]) => domain)
                          .join(", ")}
                      </span>
                    )}
                  </td>
                  <td className="py-3 text-xs text-slate-700">
                    <span className="block">
                      {changeLabel(stat.mentionRate, prior?.mentionRate)}
                    </span>
                    <span className="mt-1 block">
                      Citation {changeLabel(stat.citationRate, prior?.citationRate)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-line bg-panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">Import real captured answers</h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-700">
              Paste or upload captures you collected. WinSEO validates and stores the parsed rows
              and a SHA-256 of the exact CSV text sent to its API. It cannot verify that a provider
              produced those answers or preserve the source file's original byte encoding.
            </p>
          </div>
          <button
            type="button"
            onClick={loadExample}
            className="rounded border border-line px-3 py-2 text-sm hover:bg-slate-50"
          >
            Load illustrative example
          </button>
        </div>

        <label htmlFor="ai-visibility-csv" className="mt-4 block text-sm font-medium">
          CSV captures
        </label>
        <textarea
          id="ai-visibility-csv"
          value={csv}
          onChange={(event) => {
            setCsv(event.target.value);
            setIllustrative(false);
            setPreview(null);
            setError("");
            setNotice("");
          }}
          spellCheck={false}
          rows={9}
          className="mt-2 w-full rounded border border-line bg-white p-3 font-mono text-xs"
          placeholder="engine,prompt_id,brand_mentioned,client_cited,citation_domains,sampled_at"
        />

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="cursor-pointer rounded border border-line px-3 py-2 text-sm hover:bg-slate-50">
            Choose CSV file
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                void onFile(file);
              }}
            />
          </label>
          <button
            type="button"
            disabled={!canAnalyze}
            onClick={analyze}
            className="rounded bg-ink-950 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Validate and preview
          </button>
          {preview && !illustrative && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void saveCaptures()}
              className="rounded bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save captures to this project"}
            </button>
          )}
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
          {notice && !error && (
            <p role="status" className="text-sm text-slate-700">
              {notice}
            </p>
          )}
        </div>
      </section>

      {preview && (
        <section
          className="space-y-3 rounded-lg border border-line bg-panel p-5"
          aria-labelledby="preview-heading"
        >
          <div>
            <h2 id="preview-heading" className="font-semibold">
              {illustrative ? "Illustrative preview" : "Preview before saving"}
            </h2>
            <p className="mt-1 text-sm text-slate-700">
              Grouped by engine and prompt ID. The prompt-panel coverage is unknown because no
              expected prompt denominator is configured.
            </p>
          </div>
          {renderStats(preview)}
        </section>
      )}

      <section
        className="space-y-4 rounded-lg border border-line bg-panel p-5"
        aria-labelledby="history-heading"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="history-heading" className="font-semibold">
              Persisted capture history
            </h2>
            <p className="mt-1 text-sm text-slate-700">
              Only saved user imports appear here. A sample row is not a provider-verified result.
            </p>
          </div>
          {displayedSelection && (
            <button
              type="button"
              onClick={() => {
                exportSelected(displayedSelection, displayedPrevious);
              }}
              className="rounded border border-line px-3 py-2 text-sm hover:bg-slate-50"
            >
              Export selected batch
            </button>
          )}
        </div>

        {imports.length === 0 ? (
          <p className="rounded border border-dashed border-line p-4 text-sm text-slate-700">
            No saved capture batches yet. Import a CSV above to create the first persisted
            measurement.
          </p>
        ) : (
          <>
            <label htmlFor="capture-batch" className="block text-sm font-medium">
              Capture batch
            </label>
            <select
              id="capture-batch"
              value={selectedId}
              onChange={(event) => {
                setSelectedId(event.target.value);
              }}
              className="w-full max-w-2xl rounded border border-line bg-white px-3 py-2 text-sm"
            >
              {imports.map((item, index) => (
                <option key={item.id} value={item.id}>
                  {new Date(item.createdAt).toLocaleString()} · {item.rowCount} rows ·{" "}
                  {item.csvSha256.slice(0, 12)} · {index === 0 ? "latest" : `batch ${index + 1}`}
                </option>
              ))}
            </select>
          </>
        )}

        {displayedSelection && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded border border-line p-3">
                <p className="text-xs uppercase text-slate-700">Provenance</p>
                <p className="mt-1 font-mono text-sm">USER_SUPPLIED</p>
              </div>
              <div className="rounded border border-line p-3">
                <p className="text-xs uppercase text-slate-700">Evidence class</p>
                <p className="mt-1 font-mono text-sm">DOCUMENTED</p>
              </div>
              <div className="rounded border border-line p-3">
                <p className="text-xs uppercase text-slate-700">Rows / hash verified</p>
                <p className="mt-1 font-mono text-sm">{displayedSelection.import.rowCount} / yes</p>
              </div>
              <div className="rounded border border-warning/50 bg-warning/5 p-3">
                <p className="text-xs uppercase text-slate-700">Provider authenticity</p>
                <p className="mt-1 text-sm font-medium">Not verified</p>
              </div>
            </div>
            <p className="break-all font-mono text-xs text-slate-700">
              SHA-256: {displayedSelection.import.csvSha256}
            </p>
            <p className="rounded border border-warning/50 bg-warning/5 p-3 text-sm text-slate-700">
              AI answers vary across repeated runs. Rates and Wilson 95% intervals summarize these
              submitted samples; they are not rankings or a WinSEO GEO score. Prompt panel coverage:{" "}
              <strong>unknown</strong> without an expected prompt list.
            </p>
            {renderStats(displayedSelection.stats, displayedPrevious?.stats ?? [])}
            {displayedPrevious && (
              <p className="text-xs text-slate-700">
                Movement compares only with the preceding saved batch selected from this project.
                Changes are descriptive and do not establish causality.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
