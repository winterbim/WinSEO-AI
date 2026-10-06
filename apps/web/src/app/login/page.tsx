"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    if (!email.trim() || !password) {
      setError("Email and password are required.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      if (!res.ok) {
        setError(data.error?.message ?? "Authentication failed. Please try again.");
        return;
      }
      router.push(search.get("next") ?? "/dashboard");
      router.refresh();
    } catch {
      setError("The service is temporarily unavailable. Please retry.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <a href="/" className="text-sm text-primary underline underline-offset-2">
            SERPVERA
          </a>
          <h1 className="mt-4 text-2xl font-bold">
            {mode === "login" ? "Sign in to your workspace" : "Create your account"}
          </h1>
          <p className="mt-2 text-sm text-slate-700">
            Evidence-first search intelligence for your sites.
          </p>
        </div>

        <form
          onSubmit={(e) => {
            void submit(e);
          }}
          className="rounded-lg border border-line bg-panel p-6 shadow-sm"
          noValidate
        >
          <div className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => { setEmail(e.target.value); }}
                className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                aria-invalid={!!error || undefined}
                aria-describedby={error ? "auth-error" : undefined}
              />
            </div>
            <div>
              <label htmlFor="password" className="block text-sm font-medium">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
                minLength={8}
                value={password}
                onChange={(e) => { setPassword(e.target.value); }}
                className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                aria-invalid={!!error || undefined}
                aria-describedby={error ? "auth-error" : undefined}
              />
              {mode === "register" && (
                <p className="mt-1 text-xs text-slate-700">At least 8 characters.</p>
              )}
            </div>
          </div>

          {error && (
            <p
              id="auth-error"
              role="alert"
              className="mt-4 rounded bg-critical/10 px-3 py-2 text-sm text-critical"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="mt-6 w-full rounded-lg bg-primary px-4 py-2.5 font-medium text-white transition hover:bg-primary/90 disabled:opacity-60"
          >
            {loading ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>

          <button
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError("");
            }}
            className="mt-4 w-full text-center text-sm text-primary underline underline-offset-2"
          >
            {mode === "login"
              ? "No account yet? Create one"
              : "Already have an account? Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <LoginForm />
    </Suspense>
  );
}