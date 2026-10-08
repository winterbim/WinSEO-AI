// Loading state for project overview and nested project routes.

export default function ProjectLoading() {
  return (
    <div className="animate-pulse space-y-6" role="status" aria-label="Loading project">
      <div className="h-8 w-64 rounded bg-line" />
      <div className="h-40 rounded-lg border border-line bg-panel" />
      <div className="h-40 rounded-lg border border-line bg-panel" />
      <div className="h-40 rounded-lg border border-line bg-panel" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
