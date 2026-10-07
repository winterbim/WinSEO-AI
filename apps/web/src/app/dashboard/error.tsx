"use client";

// Error boundary for dashboard routes: shows a real message + retry,
// never a blank screen or fake data.

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div role="alert" className="rounded-lg border border-critical/30 bg-critical/10 p-6">
      <h2 className="font-semibold text-critical">Something went wrong</h2>
      <p className="mt-1 text-sm text-slate-700">{error.message}</p>
      <button
        type="button"
        onClick={reset}
        className="mt-4 rounded-lg border border-line bg-panel px-4 py-2 text-sm font-medium transition hover:bg-surface"
      >
        Try again
      </button>
    </div>
  );
}
