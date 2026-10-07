"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { GscMeasuredRecommendation } from "@/lib/types";

/**
 * Promotes a MEASURED recommendation into the Action Center: finding +
 * evidence + DETECTED action, then hands off to the approval / implementation /
 * measurement loop. The payload is the recommendation exactly as the
 * deterministic engine emitted it — nothing is re-worded client-side.
 */
export function PromoteFindingButton({
  projectId,
  recommendation,
  sourceFilters,
}: {
  projectId: string;
  recommendation: GscMeasuredRecommendation;
  sourceFilters: Record<string, string>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  async function promote() {
    setNote("");
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/gsc/findings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          module: recommendation.module,
          subject: recommendation.subject,
          datasetWindow: recommendation.datasetWindow,
          comparisonWindow: recommendation.comparisonWindow,
          sourceFilters,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        created?: boolean;
        actionId?: string;
        reason?: string;
        error?: { message?: string };
      };
      if (!res.ok) {
        setNote(body.error?.message ?? "Could not open the workflow.");
        setBusy(false);
        return;
      }
      if (body.created && body.actionId) {
        router.push(`/dashboard/${projectId}/actions/${body.actionId}`);
        return;
      }
      setNote(body.reason ?? "Already tracked in the Action Center.");
      setBusy(false);
    } catch {
      setNote("The service is temporarily unavailable.");
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void promote();
        }}
        className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition hover:bg-primary/90 disabled:opacity-60"
      >
        {busy ? "Opening…" : "Open in Action Center"}
      </button>
      {note && (
        <p role="status" className="mt-1 text-xs text-slate-700">
          {note}
        </p>
      )}
    </div>
  );
}
