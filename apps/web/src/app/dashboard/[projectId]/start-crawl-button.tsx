"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { reconcileTrackedCrawl, startProjectCrawl } from "../crawl-kickoff";
import type { CrawlRun } from "@/lib/types";
import { crawlCoverageLabel } from "@/lib/crawl-coverage";

/**
 * Triggers a fresh crawl of the project's domain through the control plane.
 * The audit runs asynchronously; the page refreshes to show new rows.
 */
export function StartCrawlButton({
  projectId,
  initialRun,
  trackingRunId = null,
}: {
  projectId: string;
  initialRun: CrawlRun | null;
  trackingRunId?: string | null;
}) {
  const router = useRouter();
  const trackedInitialRun = trackingRunId && initialRun?.id !== trackingRunId ? null : initialRun;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [runId, setRunId] = useState(
    trackingRunId ??
      (initialRun && (initialRun.status === "running" || initialRun.status === "pending")
        ? initialRun.id
        : null),
  );
  const [runStatus, setRunStatus] = useState(
    trackedInitialRun?.status ?? (trackingRunId ? "pending" : ""),
  );
  const [pages, setPages] = useState(trackedInitialRun?.pagesCrawled ?? 0);
  const [failedPages, setFailedPages] = useState(trackedInitialRun?.pagesFailed ?? 0);
  const [pageLimit, setPageLimit] = useState<number | null>(trackedInitialRun?.pageLimit ?? null);
  const [stopReason, setStopReason] = useState(trackedInitialRun?.stopReason ?? null);

  useEffect(() => {
    if (runId === null) return;
    const trackedRunId: string = runId;
    let active = true;
    let missingPolls = 0;

    async function refreshStatus() {
      try {
        const response = await fetch(`/api/v1/projects/${projectId}/crawl-runs`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Could not refresh crawl status.");
        const body = (await response.json()) as { crawlRuns?: CrawlRun[] };
        if (!active) return;
        setError("");
        const reconciliation = reconcileTrackedCrawl(body.crawlRuns, trackedRunId, missingPolls);
        if (reconciliation.kind === "retry") {
          missingPolls = reconciliation.consecutiveMisses;
          return;
        }
        if (reconciliation.kind === "missing") {
          setRunId(null);
          setRunStatus("");
          setPages(0);
          setFailedPages(0);
          setPageLimit(null);
          setStopReason(null);
          setError(
            "This crawl is not visible in project history. Open crawl history or start a new crawl.",
          );
          router.replace(`/dashboard/${projectId}`, { scroll: false });
          return;
        }
        missingPolls = 0;
        const run = reconciliation.run;
        setRunStatus(run.status);
        setPages(run.pagesCrawled);
        setFailedPages(run.pagesFailed);
        setPageLimit(run.pageLimit);
        setStopReason(run.stopReason ?? null);
        if (run.status === "completed" || run.status === "failed") {
          setRunId(null);
          router.replace(`/dashboard/${projectId}`, { scroll: false });
          router.refresh();
        }
      } catch {
        if (active)
          setError(
            "Crawl status could not be refreshed. The saved run remains available in history.",
          );
      }
    }

    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), 1_500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [projectId, router, runId]);

  // Named handler + `void` at the call site: React attributes expect void
  // returns, and the async work is intentionally fire-and-forget with its own
  // error state.
  async function runCrawl() {
    setError("");
    setBusy(true);
    const result = await startProjectCrawl(projectId);
    if (!result.ok) {
      setError(result.message);
      setBusy(false);
      return;
    }

    setError("");
    setRunId(result.crawlRun.id);
    setRunStatus(result.crawlRun.status);
    setPages(0);
    setFailedPages(0);
    setPageLimit(50);
    setStopReason(null);
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="text-right">
      <button
        type="button"
        disabled={busy || runId !== null}
        onClick={() => {
          void runCrawl();
        }}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90 disabled:opacity-60"
      >
        {busy
          ? "Starting…"
          : runId
            ? runStatus === "pending"
              ? "Crawl pending…"
              : "Crawl running…"
            : "Run crawl"}
      </button>
      {runStatus && (
        <p className="mt-2 text-xs text-slate-700" aria-live="polite">
          {runStatus === "running" || runStatus === "pending"
            ? `Crawl ${runStatus}`
            : `Crawl ${runStatus}`}{" "}
          {runStatus === "running" || runStatus === "pending" ? (
            <>· Page and failure counts are finalized when the crawl completes · </>
          ) : (
            <>
              · {pages} pages observed · {failedPages} failed ·{" "}
            </>
          )}
          {crawlCoverageLabel(runStatus, stopReason, pageLimit)}{" "}
          <Link className="text-primary underline" href={`/dashboard/${projectId}/crawls`}>
            History
          </Link>
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-critical">
          {error}
        </p>
      )}
    </div>
  );
}
