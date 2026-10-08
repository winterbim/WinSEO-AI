// Loading state for the project list (server component boundary).

export default function DashboardLoading() {
  return (
    <div className="animate-pulse space-y-4" role="status" aria-label="Loading your sites">
      <div className="h-8 w-48 rounded bg-line" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 rounded-lg border border-line bg-panel" />
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
