// Loading state for the findings table.

export default function FindingsLoading() {
  return (
    <div className="animate-pulse space-y-4" role="status" aria-label="Loading findings">
      <div className="h-8 w-48 rounded bg-line" />
      <div className="h-10 rounded-lg border border-line bg-panel" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-12 rounded border border-line bg-panel" />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}