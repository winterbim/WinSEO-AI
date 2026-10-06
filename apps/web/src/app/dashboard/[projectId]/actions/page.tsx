import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import {
  ACTION_STATES,
  ACTION_STATE_STYLES,
  SEVERITY_ORDER,
  SEVERITY_STYLES,
  type ActionItem,
} from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ActionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ status?: string; severity?: string }>;
}) {
  const { projectId } = await params;
  const filters = await searchParams;
  const query = new URLSearchParams();
  if (filters.status && ACTION_STATES.includes(filters.status as (typeof ACTION_STATES)[number])) {
    query.set("status", filters.status);
  }
  if (
    filters.severity &&
    SEVERITY_ORDER.includes(filters.severity as (typeof SEVERITY_ORDER)[number])
  ) {
    query.set("severity", filters.severity);
  }

  let actions: ActionItem[];
  try {
    const response = await apiFetch<{ actions: ActionItem[] }>(
      `/v1/projects/${projectId}/actions${query.size ? `?${query}` : ""}`,
    );
    actions = response.actions;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <div className="rounded-lg border border-line bg-panel p-6">
          <h1 className="text-lg font-semibold">Project not found</h1>
          <Link href="/dashboard" className="mt-3 inline-block text-sm text-primary underline">
            Back to your sites
          </Link>
        </div>
      );
    }
    throw error;
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-primary">
            Evidence to outcome
          </p>
          <h1 className="mt-1 text-2xl font-bold">Action Center</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-700">
            Approvals are explicit, changes are attributable, and outcomes come from the declared
            gate—not from an opinion or an aggregate SEO score.
          </p>
        </div>
        <Link href={`/dashboard/${projectId}`} className="text-sm text-primary underline">
          ← Overview
        </Link>
      </header>

      <form className="grid gap-3 rounded-lg border border-line bg-panel p-4 sm:grid-cols-[1fr_1fr_auto]">
        <label className="text-xs font-medium text-slate-700">
          Status
          <select
            name="status"
            defaultValue={filters.status ?? ""}
            className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm"
          >
            <option value="">All states</option>
            {ACTION_STATES.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-slate-700">
          Severity
          <select
            name="severity"
            defaultValue={filters.severity ?? ""}
            className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm"
          >
            <option value="">All severities</option>
            {SEVERITY_ORDER.map((severity) => (
              <option key={severity} value={severity}>
                {severity}
              </option>
            ))}
          </select>
        </label>
        <button className="self-end rounded bg-ink-950 px-4 py-2 text-sm font-medium text-white">
          Filter
        </button>
      </form>

      {actions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line bg-panel p-8 text-center">
          <p className="font-medium">No actions match this view.</p>
          <p className="mt-1 text-sm text-slate-700">
            Actions are created only from persisted findings; no placeholder work is shown.
          </p>
        </div>
      ) : (
        <ul className="grid gap-3">
          {actions.map((action) => (
            <li key={action.id}>
              <Link
                href={`/dashboard/${projectId}/actions/${action.id}`}
                className="block rounded-lg border border-line bg-panel p-5 transition hover:border-primary"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${ACTION_STATE_STYLES[action.state]}`}
                  >
                    {action.state}
                  </span>
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[action.severity] ?? ""}`}
                  >
                    {action.severity}
                  </span>
                  <span className="font-mono text-xs text-slate-700">{action.ruleId}</span>
                </div>
                <h2 className="mt-2 font-semibold">{action.findingTitle}</h2>
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-700">
                  <span>
                    {action.evidence.length} evidence item{action.evidence.length === 1 ? "" : "s"}
                  </span>
                  <span>
                    Gate: <span className="font-mono">{action.verificationGate}</span>
                  </span>
                  <span>Version {action.version}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
