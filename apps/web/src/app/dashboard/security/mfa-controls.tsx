"use client";

import { useState, type SubmitEvent } from "react";
import { useRouter } from "next/navigation";

interface Enrollment {
  secret: string;
  provisioningUri: string;
  expiresAt: string;
}

export function MfaControls({ initialEnabled }: { initialEnabled: boolean }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function submit(
    event: SubmitEvent<HTMLFormElement>,
    path: string,
    onSuccess: (body: unknown) => void,
  ) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const form = new FormData(event.currentTarget);
      const payload = Object.fromEntries(form.entries());
      const response = await fetch(`/api/v1/auth/mfa/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      } & Record<string, unknown>;
      if (!response.ok) throw new Error(body.error?.message ?? "Security update failed.");
      onSuccess(body);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Security update failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-line bg-panel p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Authenticator app</h2>
          <p className="mt-1 text-sm text-slate-700">
            Status: <strong>{enabled ? "Enabled" : "Not enabled"}</strong>
          </p>
        </div>
        {enabled && (
          <span className="rounded bg-verified/10 px-2 py-1 text-xs text-verified">Active</span>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded bg-critical/10 p-3 text-sm text-critical">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mt-4 rounded bg-verified/10 p-3 text-sm text-verified">
          {message}
        </p>
      )}

      {!enabled && !enrollment && (
        <form
          className="mt-5 flex flex-wrap items-end gap-3"
          onSubmit={(event) =>
            void submit(event, "enroll", (body) => {
              setEnrollment(body as Enrollment);
              setMessage(
                "Authenticator setup started. Confirm a code before the enrollment expires.",
              );
            })
          }
        >
          <label className="min-w-64 flex-1 text-xs font-medium text-slate-700">
            Confirm your password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm"
            />
          </label>
          <button
            disabled={busy}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Set up authenticator
          </button>
        </form>
      )}

      {enrollment && !enabled && (
        <div className="mt-5 space-y-4">
          <div className="rounded border border-warning/30 bg-warning/5 p-4 text-sm">
            <p className="font-medium">Add this account in your authenticator app</p>
            <p className="mt-2 text-xs text-slate-700">Enter this secret manually:</p>
            <code className="mt-1 block break-all rounded bg-white p-2 font-mono">
              {enrollment.secret}
            </code>
            <p className="mt-2 text-xs text-slate-700">
              The setup link is also available to compatible apps:
            </p>
            <a
              className="mt-1 block break-all text-xs text-primary underline"
              href={enrollment.provisioningUri}
            >
              Open authenticator setup link
            </a>
            <p className="mt-2 text-xs text-slate-700">
              Expires {new Date(enrollment.expiresAt).toLocaleString()}. Store the authenticator
              safely; account recovery is not configured yet.
            </p>
          </div>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) =>
              void submit(event, "confirm-enrollment", () => {
                setEnabled(true);
                setEnrollment(null);
                setMessage("Authenticator enabled.");
              })
            }
          >
            <label className="w-40 text-xs font-medium text-slate-700">
              Six-digit code
              <input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 font-mono text-sm"
              />
            </label>
            <button
              disabled={busy}
              className="rounded bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Confirm and enable
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEnrollment(null);
              }}
              className="rounded border border-line px-4 py-2 text-sm"
            >
              Cancel
            </button>
          </form>
        </div>
      )}

      {enabled && (
        <form
          className="mt-5 grid gap-3 sm:grid-cols-3"
          onSubmit={(event) =>
            void submit(event, "disable", () => {
              setEnabled(false);
              setMessage("Authenticator disabled and this session signed out.");
            })
          }
        >
          <label className="text-xs font-medium text-slate-700">
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs font-medium text-slate-700">
            Current authenticator code
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 font-mono text-sm"
            />
          </label>
          <button
            disabled={busy}
            className="self-end rounded border border-critical/40 bg-white px-4 py-2 text-sm font-medium text-critical disabled:opacity-50"
          >
            Disable and sign out
          </button>
        </form>
      )}
    </section>
  );
}
