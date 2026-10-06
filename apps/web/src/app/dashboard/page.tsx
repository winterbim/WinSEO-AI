// /dashboard — the authenticated project list (REAL rows from PostgreSQL).
// First screen after login: shows persisted projects or an honest empty state.

import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import type { Project } from "@/lib/types";
import { CreateProjectForm } from "./create-project-form";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  let projects: Project[] = [];
  let loadError = "";

  try {
    const res = await apiFetch<{ projects: Project[] }>("/v1/projects");
    projects = res.projects;
  } catch (err) {
    if (err instanceof ApiError) loadError = err.message;
    else throw err;
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Your sites</h1>
        <p className="mt-1 text-sm text-slate-700">
          Each site is crawled with deterministic rules; every finding carries its
          evidence.
        </p>
      </div>

      {loadError && (
        <div role="alert" className="rounded-lg border border-critical/30 bg-critical/10 p-4 text-sm text-critical">
          Could not load your sites: {loadError}
        </div>
      )}

      {projects.length === 0 && !loadError && (
        <div className="rounded-lg border border-dashed border-line bg-panel p-8 text-center">
          <p className="font-medium">No sites yet.</p>
          <p className="mt-1 text-sm text-slate-700">
            Add your first domain below — you will get evidence-backed findings, not a
            generic score.
          </p>
        </div>
      )}

      {projects.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/dashboard/${p.id}`}
                className="block rounded-lg border border-line bg-panel p-5 transition hover:border-primary"
              >
                <span className="font-semibold text-ink-950">{p.name}</span>
                <span className="mt-1 block truncate font-mono text-sm text-slate-700">
                  {p.primaryDomain}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <CreateProjectForm />
    </div>
  );
}