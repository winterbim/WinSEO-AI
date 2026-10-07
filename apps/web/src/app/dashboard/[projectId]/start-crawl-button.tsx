"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { startProjectCrawl } from "../crawl-kickoff";

/**
 * Triggers a fresh crawl of the project's domain through the control plane.
 * The audit runs asynchronously; the page refreshes to show new rows.
 */
export function StartCrawlButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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

    // Give the worker a head start, then reload the real rows.
    setTimeout(() => {
      router.refresh();
      setBusy(false);
    }, 2500);
  }

  return (
    <div className="text-right">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void runCrawl();
        }}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90 disabled:opacity-60"
      >
        {busy ? "Crawling…" : "Run crawl"}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-xs text-critical">
          {error}
        </p>
      )}
    </div>
  );
}
