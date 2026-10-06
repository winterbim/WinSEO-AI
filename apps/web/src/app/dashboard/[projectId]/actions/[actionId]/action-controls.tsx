"use client";

import { useState, type SubmitEvent } from "react";
import { useRouter } from "next/navigation";
import type { ActionItem } from "@/lib/types";

export function ActionControls({ action }: { action: ActionItem }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function transition(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/actions/${action.id}/transitions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: action.version, ...payload }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Transition failed.");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Transition failed.");
    } finally {
      setBusy(false);
    }
  }

  function formValue(event: SubmitEvent<HTMLFormElement>, name: string): string {
    const value = new FormData(event.currentTarget).get(name);
    // Text fields only: File entries would stringify as "[object File]".
    return (typeof value === "string" ? value : "").trim();
  }

  return (
    <section
      aria-labelledby="controls"
      className="rounded-lg border border-primary/30 bg-primary/5 p-5"
    >
      <h2 id="controls" className="font-semibold">
        Next controlled transition
      </h2>
      {error && (
        <p role="alert" className="mt-2 rounded bg-critical/10 p-2 text-sm text-critical">
          {error}
        </p>
      )}

      {action.state === "DETECTED" && (
        <button
          disabled={busy}
          onClick={() => {
            void transition({ toState: "EVIDENCED" });
          }}
          className="mt-3 rounded bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Confirm linked evidence
        </button>
      )}

      {(action.state === "EVIDENCED" || action.state === "INCONCLUSIVE") && (
        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void transition({
              toState: "PROPOSED",
              recommendation: {
                summary: formValue(event, "summary"),
                rationale: formValue(event, "rationale"),
                verificationGate: { type: action.verificationGate, spec: {} },
              },
            });
          }}
        >
          <label className="block text-xs font-medium text-slate-700">
            Recommendation
            <textarea
              name="summary"
              required
              defaultValue={
                typeof action.recommendation?.summary === "string"
                  ? action.recommendation.summary
                  : ""
              }
              className="mt-1 min-h-24 w-full rounded border border-line bg-white p-3 text-sm"
            />
          </label>
          <label className="block text-xs font-medium text-slate-700">
            Rationale
            <textarea
              name="rationale"
              className="mt-1 min-h-20 w-full rounded border border-line bg-white p-3 text-sm"
            />
          </label>
          <button
            disabled={busy}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Propose with gate
          </button>
        </form>
      )}

      {action.state === "PROPOSED" && (
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <button
            disabled={busy}
            onClick={() => {
              void transition({ toState: "APPROVED", approvalDecision: "APPROVE" });
            }}
            className="self-start rounded bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Approve explicitly
          </button>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void transition({
                toState: "REJECT_PROPOSAL",
                approvalDecision: "REJECT",
                note: formValue(event, "rejectionReason"),
              });
            }}
          >
            <textarea
              name="rejectionReason"
              required
              placeholder="Reason for rejecting this recommendation"
              className="min-h-20 w-full rounded border border-line bg-white p-3 text-sm"
            />
            <button
              disabled={busy}
              className="rounded border border-critical/40 bg-white px-4 py-2 text-sm font-medium text-critical disabled:opacity-50"
            >
              Reject recommendation
            </button>
          </form>
          <p className="text-xs text-slate-700 md:col-span-2">
            A rejected recommendation returns to EVIDENCED with its reason in the audit trail. The
            REJECTED outcome remains reserved for a failed verification gate.
          </p>
        </div>
      )}

      {action.state === "APPROVED" && (
        <form
          className="mt-3 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void transition({
              toState: "REPORTED_MANUALLY",
              implementation: {
                whatChanged: formValue(event, "whatChanged"),
                how: formValue(event, "how"),
              },
              rollback: {
                strategy: formValue(event, "rollback"),
                trigger: formValue(event, "rollbackTrigger"),
              },
            });
          }}
        >
          <textarea
            name="whatChanged"
            required
            placeholder="What was manually published"
            className="min-h-24 rounded border border-line bg-white p-3 text-sm"
          />
          <input
            name="how"
            required
            placeholder="How / release / method"
            className="rounded border border-line bg-white px-3 py-2 text-sm"
          />
          <textarea
            name="rollback"
            required
            placeholder="Manual rollback instructions"
            className="min-h-20 rounded border border-line bg-white p-3 text-sm"
          />
          <input
            name="rollbackTrigger"
            placeholder="Rollback trigger"
            className="rounded border border-line bg-white px-3 py-2 text-sm"
          />
          <button
            disabled={busy}
            className="justify-self-start rounded bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Declare manual publication
          </button>
        </form>
      )}

      {action.state === "REPORTED_MANUALLY" && (
        <p className="mt-3 rounded border border-warning/30 bg-warning/5 p-3 text-sm text-slate-700">
          Publication is declared by a person and has not been verified online. Continue to a
          recrawl only after the change is visible on the site.
        </p>
      )}

      {action.state === "REPORTED_MANUALLY" && (
        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const startsAt = new Date().toISOString();
            const days = Math.max(1, Number(formValue(event, "days")) || 7);
            void transition({
              toState: "MEASURING",
              baselineSnapshot: { note: formValue(event, "baseline"), capturedAt: startsAt },
              comparisonWindow: {
                startsAt,
                endsAt: new Date(Date.now() + days * 86_400_000).toISOString(),
              },
            });
          }}
        >
          <textarea
            name="baseline"
            required
            placeholder="Baseline snapshot / observable before state"
            className="min-h-24 w-full rounded border border-line bg-white p-3 text-sm"
          />
          <label className="block text-xs font-medium text-slate-700">
            Comparison window (days)
            <input
              name="days"
              type="number"
              min="1"
              defaultValue="7"
              className="ml-2 w-24 rounded border border-line bg-white px-3 py-2 text-sm"
            />
          </label>
          <button
            disabled={busy}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Start measuring
          </button>
        </form>
      )}

      {action.state === "MEASURING" && (
        <div className="mt-3">
          <button
            disabled={busy}
            onClick={() => {
              void transition({ toState: "EVALUATE" });
            }}
            className="rounded bg-ink-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Run declared gate
          </button>
          <p className="mt-2 text-xs text-slate-700">
            The server chooses VERIFIED, REJECTED or INCONCLUSIVE from persisted crawl data. This
            control cannot choose its own verdict.
          </p>
        </div>
      )}

      {(["VERIFIED", "REJECTED"] as const).includes(action.state as "VERIFIED" | "REJECTED") && (
        <button
          disabled={busy}
          onClick={() => {
            void transition({ toState: "CLOSED", note: "Outcome reviewed in Action Center." });
          }}
          className="mt-3 rounded bg-ink-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Close action
        </button>
      )}

      {action.state === "CLOSED" && (
        <p className="mt-2 text-sm text-slate-700">
          This workflow is closed. Its evidence and history remain readable.
        </p>
      )}
    </section>
  );
}
