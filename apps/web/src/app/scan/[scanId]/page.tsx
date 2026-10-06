"use client";

import { useParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";

interface ScanData {
  domain: string;
  status: string;
  createdAt: string;
  findings: Finding[];
  evidence: Evidence[];
  error?: string | null;
}

interface Finding {
  ruleId: string;
  title: string;
  epistemicClass: string;
  severity: string;
  explanation: string;
  recommendation?: string;
  affectedUrls: string[];
}

interface Evidence {
  kind: string;
  sourceRef: string;
  capturedAt: string;
  summary: string;
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "border-l-critical text-critical",
  high: "border-l-critical text-critical",
  medium: "border-l-warning text-warning",
  low: "border-l-slate-700 text-slate-700",
};

const EPISTEMIC_BADGES: Record<string, string> = {
  OBSERVED: "bg-verified/10 text-verified",
  MEASURED: "bg-verified/10 text-verified",
  INFERRED: "bg-geo/10 text-geo",
  HYPOTHESIS: "bg-warning/10 text-warning",
};

export default function ScanPage() {
  const params = useParams();
  const scanId = params.scanId as string;
  const [scan, setScan] = useState<ScanData | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/scan?scanId=${encodeURIComponent(scanId)}`);
      if (!res.ok) {
        setError("Scan not found.");
        return;
      }
      const data = (await res.json()) as ScanData;
      setScan(data);
      // Stop polling once the control plane reports a terminal state.
      if (data.status === "completed" || data.status === "failed") {
        setDone(true);
      }
    } catch {
      setError("Unable to load scan results.");
    }
  }, [scanId]);

  useEffect(() => {
    void poll();
    const interval = setInterval(() => {
      if (!done) void poll();
    }, 2000);
    return () => {
      clearInterval(interval);
    };
  }, [poll, done]);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <div className="rounded-lg border border-line bg-panel p-8 text-center">
          <p className="text-critical">{error}</p>
          <a href="/" className="mt-4 inline-block text-primary underline">
            Try again
          </a>
        </div>
      </main>
    );
  }

  if (!scan) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="mt-4 text-slate-700">Loading scan...</p>
        </div>
      </main>
    );
  }

  // Terminal states: "completed" renders results; "failed" renders an honest
  // failure notice plus whatever partial findings the crawler recorded.
  if (scan.status !== "completed" && scan.status !== "failed") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center px-4">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="mt-4 text-lg font-medium">Scanning {scan.domain}</p>
          <p className="mt-2 text-sm text-slate-700">
            Checking title, meta description, H1, canonical, and robots directives...
          </p>
        </div>
      </main>
    );
  }

  // The API contract guarantees arrays (the DB store coalesces nullable JSONB
  // before serialising), so no runtime fallback is needed here.
  const findings = scan.findings;
  const evidence = scan.evidence;

  return (
    <main className="min-h-screen bg-surface px-4 py-12">
      <div className="mx-auto max-w-3xl">
        {scan.status === "failed" && (
          <div
            className="mb-6 rounded-lg border border-l-4 border-line border-l-critical bg-panel p-5"
            role="alert"
          >
            <h2 className="font-semibold text-critical">The audit did not complete</h2>
            <p className="mt-1 text-sm text-slate-700">
              {scan.error ??
                "The crawler could not retrieve the site. No results were fabricated for this scan."}
            </p>
            <p className="mt-3 text-xs text-slate-700">
              A failed audit produces no verified findings. Any entries below are only the errors
              the crawler actually observed.
            </p>
          </div>
        )}
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold">Public audit: {scan.domain}</h1>
          <p className="mt-1 text-sm text-slate-700">
            Scanned at {new Date(scan.createdAt).toLocaleString()}
          </p>
        </div>

        {/* Summary */}
        {scan.status === "completed" && findings.length === 0 ? (
          <div className="rounded-lg border border-line bg-panel p-6 text-center">
            <p className="text-lg font-medium text-verified">
              No issues detected on the requested page {scan.domain}.
            </p>
            <p className="mt-2 text-sm text-slate-700">
              This public audit covers one page. A site-wide crawl may reveal more.
            </p>
          </div>
        ) : findings.length === 0 ? (
          <div className="mb-6">
            <p className="text-sm text-slate-700">
              No verified findings were recorded for this scan.
            </p>
          </div>
        ) : (
          <div className="mb-6">
            <p className="font-medium">
              {findings.length} issue{findings.length > 1 ? "s" : ""} found
            </p>
          </div>
        )}

        {/* Findings */}
        <div className="space-y-4">
          {findings.map((f, i) => (
            <div
              key={i}
              className={`rounded-lg border border-line bg-panel p-5 border-l-4 ${SEVERITY_COLORS[f.severity] ?? "border-l-primary text-primary"}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded px-2 py-0.5 text-xs font-medium bg-ink-950 text-white">
                  {f.ruleId}
                </span>
                <span
                  className={`rounded px-2 py-0.5 text-xs font-medium ${EPISTEMIC_BADGES[f.epistemicClass] ?? "bg-slate-700/10"}`}
                >
                  {f.epistemicClass}
                </span>
              </div>
              <h2 className="mt-2 text-lg font-semibold text-ink-950">{f.title}</h2>
              <p className="mt-2 text-sm text-slate-700">{f.explanation}</p>
              {f.recommendation && (
                <div className="mt-3 rounded bg-surface p-3">
                  <p className="text-sm font-medium text-ink-950">Recommendation</p>
                  <p className="mt-1 text-sm text-slate-700">{f.recommendation}</p>
                </div>
              )}
              <p className="mt-3 text-xs text-slate-700">
                Evidence:{" "}
                {evidence
                  .filter((e) => e.sourceRef === f.affectedUrls[0])
                  .map((e) => e.summary)
                  .join("; ") || "No captured evidence available for this finding."}
              </p>
            </div>
          ))}
        </div>

        {/* CTA */}
        <div className="mt-10 rounded-lg border-2 border-primary/30 bg-primary/5 p-8 text-center">
          <h3 className="text-xl font-bold">This was a limited public audit.</h3>
          <p className="mt-2 text-slate-700">
            Only the submitted URL was checked. Connect Google Search Console and run a full site
            crawl to detect site-wide technical issues, monitor search performance, and get
            evidence-backed recommendations.
          </p>
          <div className="mt-6 flex justify-center gap-4">
            <a
              href="/signup"
              className="rounded-lg bg-primary px-6 py-3 font-medium text-white transition hover:bg-primary/90"
            >
              Create account — Free
            </a>
            <a
              href="/methodology"
              className="rounded-lg border border-line bg-panel px-6 py-3 font-medium text-ink-950 transition hover:bg-surface"
            >
              See methodology
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
