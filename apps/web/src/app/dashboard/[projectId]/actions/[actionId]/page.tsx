import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import {
  ACTION_STATE_STYLES,
  SEVERITY_STYLES,
  type ActionItem,
  type GscBeforeAfter,
} from "@/lib/types";
import { ActionControls } from "./action-controls";

export const dynamic = "force-dynamic";

function fmt(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function JsonView({ value }: { value: Record<string, unknown> | null }) {
  return value ? (
    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-surface p-3 text-xs text-slate-700">
      {JSON.stringify(value, null, 2)}
    </pre>
  ) : (
    <p className="mt-2 text-sm text-slate-700">Not recorded yet.</p>
  );
}

/** Baseline vs measured rows per metric, from the GSC remeasurement. */
function ComparisonRows({
  comparison,
}: {
  comparison: NonNullable<GscBeforeAfter["comparison"]>;
}) {
  return (
    <>
      {(["clicks", "impressions", "ctr", "position"] as const).map((metric) => {
        const baseline = comparison.baseline?.[metric] ?? "—";
        const observed = comparison.observed[metric] ?? "—";
        const delta = comparison.delta?.[metric];
        return (
          <tr key={metric} className="border-b border-line/60">
            <td className="py-2 pr-4">{metric}</td>
            <td className="py-2 pr-4 text-right font-mono">{String(baseline)}</td>
            <td className="py-2 pr-4 text-right font-mono">{String(observed)}</td>
            <td className="py-2 text-right font-mono">
              {delta !== undefined ? delta.toFixed(4) : "—"}
            </td>
          </tr>
        );
      })}
    </>
  );
}

export default async function ActionDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; actionId: string }>;
}) {
  const { projectId, actionId } = await params;
  let action: ActionItem;
  try {
    action = (await apiFetch<{ action: ActionItem }>(`/v1/actions/${actionId}`)).action;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <div className="rounded-lg border border-line bg-panel p-6">
          <h1 className="text-lg font-semibold">Action not found</h1>
          <p className="mt-1 text-sm text-slate-700">
            It is absent or belongs to another workspace.
          </p>
          <Link
            href={`/dashboard/${projectId}/actions`}
            className="mt-3 inline-block text-sm text-primary underline"
          >
            ← Back to actions
          </Link>
        </div>
      );
    }
    throw error;
  }

  // GSC remeasurement surface: absent (recrawl gates), unconfigured or
  // unmeasured all render as notes — never as numbers.
  let gsc: GscBeforeAfter | null = null;
  let gscNote = "";
  try {
    gsc = await apiFetch<GscBeforeAfter>(`/v1/gsc/actions/${actionId}/before-after`);
  } catch (error) {
    if (error instanceof ApiError) {
      gscNote =
        error.status === 409
          ? "This action declares no GSC gate (it uses a recrawl gate)."
          : error.message;
    } else {
      throw error;
    }
  }

  return (
    <article className="mx-auto max-w-5xl space-y-6">
      <Link
        href={`/dashboard/${projectId}/actions`}
        className="inline-block text-sm text-primary underline"
      >
        ← Back to Action Center
      </Link>

      <header className="rounded-lg border border-line bg-panel p-6">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${ACTION_STATE_STYLES[action.state]}`}
          >
            {action.state === "REPORTED_MANUALLY"
              ? "Déclaré manuellement · non vérifié"
              : action.state}
          </span>
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[action.severity] ?? ""}`}
          >
            {action.severity}
          </span>
          <span className="font-mono text-xs text-slate-700">{action.ruleId}</span>
        </div>
        <h1 className="mt-3 text-2xl font-bold">{action.findingTitle}</h1>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-700">Gate</dt>
            <dd className="font-mono">{action.verificationGate}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-700">Version</dt>
            <dd>{action.version}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-700">Updated</dt>
            <dd>{fmt(action.updatedAt ?? action.createdAt)}</dd>
          </div>
        </dl>
      </header>

      <ActionControls action={action} />

      <section className="grid gap-4 lg:grid-cols-2" aria-label="Before and after">
        <div className="rounded-lg border border-line bg-panel p-5">
          <h2 className="font-semibold">Before · baseline</h2>
          <JsonView value={action.baseline} />
        </div>
        <div className="rounded-lg border border-line bg-panel p-5">
          <h2 className="font-semibold">After · gate result</h2>
          <JsonView value={action.verification} />
        </div>
      </section>

      <section className="rounded-lg border border-line bg-panel p-5" aria-label="GSC remeasurement">
        <h2 className="font-semibold">GSC before / after (measured)</h2>
        {gscNote && <p className="mt-2 text-sm text-slate-700">{gscNote}</p>}
        {gsc && (
          <>
            <p className="mt-2 text-xs text-slate-700">
              Subject <span className="font-mono">{JSON.stringify(gsc.subject)}</span> · baseline{" "}
              <span className="font-mono">
                {gsc.baselineWindow.startDate} → {gsc.baselineWindow.endDate}
              </span>{" "}
              vs measurement{" "}
              <span className="font-mono">
                {gsc.measurementWindow.startDate} → {gsc.measurementWindow.endDate}
              </span>
            </p>
            {gsc.comparison ? (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">
                    Baseline and measured values with deltas per metric
                  </caption>
                  <thead>
                    <tr className="border-b border-line text-xs uppercase tracking-wide text-slate-700">
                      <th scope="col" className="py-2 pr-4">Metric</th>
                      <th scope="col" className="py-2 pr-4 text-right">Baseline</th>
                      <th scope="col" className="py-2 pr-4 text-right">Measured</th>
                      <th scope="col" className="py-2 text-right">Delta</th>
                    </tr>
                  </thead>
                  <tbody>
                    <ComparisonRows comparison={gsc.comparison} />
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-slate-700">
                  Evidence class <strong>MEASURED</strong> · dataset window{" "}
                  <span className="font-mono">
                    {gsc.comparison.datasetWindow.startDate} → {gsc.comparison.datasetWindow.endDate}
                  </span>{" "}
                  · freshness: latest measured day {gsc.freshness.latestMetricDate ?? "—"}
                </p>
              </div>
            ) : (
              <p className="mt-2 text-sm text-slate-700">
                Not enough measured rows in both windows to state a comparison.
              </p>
            )}
          </>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-line bg-panel p-5">
          <h2 className="font-semibold">Recommendation</h2>
          <JsonView value={action.recommendation} />
        </div>
        <div className="rounded-lg border border-line bg-panel p-5">
          <h2 className="font-semibold">Implementation & rollback</h2>
          <JsonView value={action.implementation} />
          <h3 className="mt-4 text-sm font-semibold">Rollback</h3>
          <JsonView value={action.rollback} />
        </div>
      </section>

      <section className="rounded-lg border border-line bg-panel p-5">
        <h2 className="font-semibold">Evidence ({action.evidence.length})</h2>
        {action.evidence.length === 0 ? (
          <p className="mt-2 text-sm text-critical">
            No linked evidence. This action cannot advance.
          </p>
        ) : (
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {action.evidence.map((item) => (
              <li key={item.id} className="rounded border border-line bg-surface p-3 text-xs">
                <div className="flex justify-between gap-2">
                  <strong>{item.kind}</strong>
                  <span>{fmt(item.capturedAt)}</span>
                </div>
                <p className="mt-2 break-all font-mono">{item.sourceRef}</p>
                <p className="mt-1 break-all font-mono text-slate-700">
                  sha256: {item.contentHash}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-line bg-panel p-5">
        <h2 className="font-semibold">Verification timeline</h2>
        {action.history.length === 0 ? (
          <p className="mt-2 text-sm text-slate-700">No accepted transition yet.</p>
        ) : (
          <ol className="mt-4 space-y-4 border-l border-line pl-5">
            {action.history.map((event) => (
              <li key={event.id} className="relative">
                <span className="absolute -left-[1.55rem] top-1 h-2 w-2 rounded-full bg-primary" />
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <strong>
                    {event.fromState} → {event.toState}
                  </strong>
                  <span className="text-xs text-slate-700">
                    v{event.actionVersion} · {fmt(event.createdAt)} · {event.actorEmail ?? "system"}
                  </span>
                </div>
                {Object.keys(event.payload).length > 0 && <JsonView value={event.payload} />}
              </li>
            ))}
          </ol>
        )}
      </section>
    </article>
  );
}
