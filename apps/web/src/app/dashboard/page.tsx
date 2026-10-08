// /dashboard — the authenticated project list (REAL rows from PostgreSQL).
// First screen after login: shows persisted projects or an honest empty state.

import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import type { Project } from "@/lib/types";
import { CreateProjectForm } from "./create-project-form";

interface Organization {
  id: string;
  name: string;
}

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  let projects: Project[] = [];
  let loadError = "";
  let organizations: Organization[] = [];
  let workspaceSetupError = "";
  let needsWorkspaceSelection = false;

  try {
    const orgsRes = await apiFetch<{ organizations: Organization[] }>("/v1/organizations");
    organizations = orgsRes.organizations;
  } catch (err) {
    if (err instanceof ApiError) loadError = err.message;
    else throw err;
  }

  if (!loadError && organizations.length === 0) {
    // New registrations have no tenant context yet. Show the setup form and
    // let it create the first workspace instead of making a tenant-scoped
    // project request that can only fail with NO_ACTIVE_ORGANIZATION.
    workspaceSetupError = "Create your first workspace and add a site to get started.";
  } else if (!loadError) {
    try {
      const res = await apiFetch<{ projects: Project[] }>("/v1/projects");
      projects = res.projects;
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 400 &&
        err.message === "Select an organization first."
      ) {
        needsWorkspaceSelection = true;
      } else if (err instanceof ApiError) {
        loadError = err.message;
      } else {
        throw err;
      }
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Your sites</h1>
        <p className="mt-1 text-sm text-slate-700">
          Each site is crawled with deterministic rules; every finding carries its evidence.
        </p>
      </div>

      {loadError && (
        <div
          role="alert"
          className="rounded-lg border border-critical/30 bg-critical/10 p-4 text-sm text-critical"
        >
          Could not load your sites: {loadError}
        </div>
      )}

      {workspaceSetupError && (
        <div
          className="rounded-lg border border-primary/30 bg-panel p-4 text-sm text-slate-700"
          role="status"
        >
          {workspaceSetupError}
        </div>
      )}

      {needsWorkspaceSelection && (
        <div
          className="rounded-lg border border-line bg-panel p-4 text-sm text-slate-700"
          role="status"
        >
          Choose a workspace to load its sites. You can also add a site to a workspace below.
        </div>
      )}

      {projects.length === 0 &&
        organizations.length > 0 &&
        !needsWorkspaceSelection &&
        !loadError && (
          <div className="rounded-lg border border-dashed border-line bg-panel p-8 text-center">
            <p className="font-medium">No sites yet.</p>
            <p className="mt-1 text-sm text-slate-700">
              Add your first domain below — you will get evidence-backed findings, not a generic
              score.
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

      <CreateProjectForm
        organizations={organizations}
        needsWorkspaceSelection={needsWorkspaceSelection}
      />
    </div>
  );
}
