// Dashboard shell: auth guard (server-side, via control plane) + stable nav.
// Navigation answers Blueprint §6: Overview / Actions(findings) / Changes
// (crawl history) / Evidence / Settings-less MVP scope.

import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { LogoutButton } from "./logout-button";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Auth guard: apiFetch redirects to /login on 401.
  await apiFetch<{ user: { id: string; email: string } }>("/v1/auth/me");

  return (
    <div className="min-h-screen bg-surface">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="font-bold text-ink-950">
              SERPVERA
            </Link>
            <nav aria-label="Workspace" className="flex gap-4 text-sm">
              <Link href="/dashboard" className="text-slate-700 hover:text-ink-950">
                Overview
              </Link>
              <Link href="/dashboard/security" className="text-slate-700 hover:text-ink-950">
                Security
              </Link>
              <span className="text-slate-700/50" aria-hidden="true">
                ·
              </span>
            </nav>
          </div>
          <LogoutButton />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
