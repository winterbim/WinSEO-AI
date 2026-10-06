"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Starts the Google OAuth consent flow. The control plane builds the consent
 * URL server-side (secrets never reach the browser); the client navigates to it.
 */
export function GscConnectButton({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function connect() {
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/v1/gsc/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        authorizeUrl?: string;
        error?: { message?: string };
      };
      if (!res.ok || !body.authorizeUrl) {
        setError(body.error?.message ?? "Could not start the Google flow.");
        setBusy(false);
        return;
      }
      window.location.assign(body.authorizeUrl);
    } catch {
      setError("The service is temporarily unavailable.");
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void connect();
        }}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90 disabled:opacity-60"
      >
        {busy ? "Opening Google…" : "Connect Google Search Console"}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-xs text-critical">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Runs one incremental sync (the control plane derives the window from the
 * connection's last completed sync) and reloads the real rows.
 */
export function GscSyncButton({
  projectId,
  connectionId,
}: {
  projectId: string;
  connectionId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function sync() {
    setMessage("");
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/gsc/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        outcome?: { status: string; rowCount: number; error?: { message?: string } | null };
        error?: { message?: string };
      };
      if (!res.ok || !body.outcome) {
        setMessage(body.error?.message ?? "Sync could not run.");
        setBusy(false);
        return;
      }
      const outcome = body.outcome;
      setMessage(
        outcome.status === "COMPLETED"
          ? `Synced ${outcome.rowCount} measured rows.`
          : `${outcome.status}${outcome.error?.message ? `: ${outcome.error.message}` : ""}`,
      );
      router.refresh();
      setBusy(false);
    } catch {
      setMessage("The service is temporarily unavailable.");
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void sync();
        }}
        className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium transition hover:bg-panel disabled:opacity-60"
      >
        {busy ? "Syncing…" : "Sync now"}
      </button>
      {message && (
        <p role="status" className="mt-2 text-xs text-slate-700">
          {message}
        </p>
      )}
    </div>
  );
}
