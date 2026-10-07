"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { startProjectCrawl } from "./crawl-kickoff";
import {
  clearPendingProjectCreation,
  normalizeProjectDomain,
  postProjectCreation,
  readPendingProjectCreation,
  savePendingProjectCreation,
  type PendingProjectCreation,
  type ProjectCreationPayload,
} from "./project-creation";
import { resolveWorkspaceChoice, type WorkspaceOption } from "./workspace-selection";

interface OrgResponse {
  organizations: WorkspaceOption[];
}
interface ProjectResponse {
  project: { id: string };
}
interface ErrResponse {
  error?: { message?: string };
}

interface CreateProjectFormProps {
  organizations: WorkspaceOption[];
  needsWorkspaceSelection: boolean;
}

async function readErr(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as ErrResponse;
  return body.error?.message ?? fallback;
}

export function CreateProjectForm({
  organizations: initialOrganizations,
  needsWorkspaceSelection,
}: CreateProjectFormProps) {
  const router = useRouter();
  const [domain, setDomain] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [organizations, setOrganizations] = useState(initialOrganizations);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [projectRetry, setProjectRetry] = useState<PendingProjectCreation | null>(null);
  const [attemptReady, setAttemptReady] = useState(false);
  const [selectedOrgId, setSelectedOrgId] = useState(
    initialOrganizations.length === 1 ? (initialOrganizations.at(0)?.id ?? "") : "",
  );
  const [createdProject, setCreatedProject] = useState<{ id: string; domain: string } | null>(null);
  const [crawlError, setCrawlError] = useState("");

  useEffect(() => {
    try {
      const pending = readPendingProjectCreation(window.sessionStorage);
      if (pending) {
        setProjectRetry(pending);
        setIdempotencyKey(pending.idempotencyKey);
        setDomain(pending.primaryDomain);
        setSelectedOrgId(pending.organizationId);
      } else {
        setIdempotencyKey(crypto.randomUUID());
      }
    } catch {
      setIdempotencyKey(crypto.randomUUID());
    } finally {
      setAttemptReady(true);
    }
  }, []);

  async function fetchOrganizations(): Promise<WorkspaceOption[] | null> {
    const orgsRes = await fetch("/api/v1/organizations");
    if (!orgsRes.ok) {
      setError(await readErr(orgsRes, "Workspace lookup failed."));
      return null;
    }
    const orgs = (await orgsRes.json()) as OrgResponse;
    setOrganizations(orgs.organizations);
    if (!orgs.organizations.some((organization) => organization.id === selectedOrgId)) {
      setSelectedOrgId(orgs.organizations.length === 1 ? (orgs.organizations.at(0)?.id ?? "") : "");
    }
    return orgs.organizations;
  }

  async function activateWorkspace(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setWorkspaceError("");
    setWorkspaceLoading(true);
    try {
      const available = await fetch("/api/v1/organizations");
      if (!available.ok) {
        setWorkspaceError(await readErr(available, "Workspace lookup failed."));
        return;
      }
      const orgs = (await available.json()) as OrgResponse;
      setOrganizations(orgs.organizations);
      const choice = resolveWorkspaceChoice(orgs.organizations, selectedOrgId);
      if (choice.kind === "create") {
        setWorkspaceError("Create your first workspace by adding a site below.");
        return;
      }
      if (choice.kind === "choose") {
        setWorkspaceError("Choose a workspace before continuing.");
        return;
      }

      const selRes = await fetch("/api/v1/auth/select-organization", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: choice.workspace.id }),
      });
      if (!selRes.ok) {
        setWorkspaceError(await readErr(selRes, "Could not activate your workspace."));
        return;
      }
      router.refresh();
    } catch {
      setWorkspaceError("The service is temporarily unavailable. Please retry.");
    } finally {
      setWorkspaceLoading(false);
    }
  }

  async function submit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const normalizedDomain = normalizeProjectDomain(domain);
    if (!normalizedDomain.ok) {
      setError(normalizedDomain.message);
      return;
    }
    const clean = normalizedDomain.primaryDomain;
    setDomain(clean);
    setLoading(true);
    try {
      // 1) Resolve the workspace from the caller's server-verified memberships.
      //    select-organization is what puts the tenant into the session; the
      //    server derives the role from the membership row (never client input).
      const available = await fetchOrganizations();
      if (!available) return;

      const choice = resolveWorkspaceChoice(available, selectedOrgId);
      let orgId: string;
      if (choice.kind === "selected") {
        orgId = choice.workspace.id;
      } else if (choice.kind === "choose") {
        setError("Choose a workspace before adding this site.");
        return;
      } else {
        const createRes = await fetch("/api/v1/organizations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "My workspace" }),
        });
        if (!createRes.ok) {
          setError(await readErr(createRes, "Could not create your workspace."));
          return;
        }
        orgId = ((await createRes.json()) as { organization: { id: string } }).organization.id;
      }

      const selRes = await fetch("/api/v1/auth/select-organization", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: orgId }),
      });
      if (!selRes.ok) {
        setError(await readErr(selRes, "Could not activate your workspace."));
        return;
      }

      // 2) Create the project under the active tenant.
      const payload: ProjectCreationPayload = {
        primaryDomain: clean,
        organizationId: orgId,
        name: clean,
      };
      const attempt = projectRetry ?? { ...payload, idempotencyKey };
      if (
        attempt.organizationId !== payload.organizationId ||
        attempt.primaryDomain !== payload.primaryDomain ||
        attempt.name !== payload.name
      ) {
        setError(
          "The previous creation request may have succeeded. Retry it with the same site and workspace.",
        );
        return;
      }
      setProjectRetry(attempt);
      try {
        savePendingProjectCreation(window.sessionStorage, attempt);
      } catch {
        // The in-memory attempt still protects retries in this page session.
      }

      let projRes: Response;
      try {
        projRes = await postProjectCreation(payload, attempt.idempotencyKey);
      } catch {
        setError(
          "Could not confirm whether the project was created. Retry with the same site and workspace.",
        );
        return;
      }
      if (!projRes.ok) {
        const message = await readErr(projRes, "Could not create the project.");
        if (projRes.status < 500 && projRes.status !== 409) {
          setProjectRetry(null);
          setIdempotencyKey(crypto.randomUUID());
          try {
            clearPendingProjectCreation(window.sessionStorage);
          } catch {
            // Storage may be unavailable; the next attempt still has a fresh key.
          }
        }
        setError(
          projRes.status >= 500 || projRes.status === 409
            ? `${message} Retry without changing the site or workspace.`
            : message,
        );
        return;
      }
      const project = (await projRes.json()) as ProjectResponse;
      setProjectRetry(null);
      setIdempotencyKey(crypto.randomUUID());
      try {
        clearPendingProjectCreation(window.sessionStorage);
      } catch {
        // The project response confirms creation; stale local state is harmless.
      }
      setCreatedProject({ id: project.project.id, domain: clean });
      const crawl = await startProjectCrawl(project.project.id);
      if (!crawl.ok) {
        setCrawlError(crawl.message);
        return;
      }
      router.push(`/dashboard/${project.project.id}`);
      router.refresh();
    } catch {
      setError("The service is temporarily unavailable. Please retry.");
    } finally {
      setLoading(false);
    }
  }

  async function retryFirstCrawl() {
    if (!createdProject) return;
    setLoading(true);
    setCrawlError("");
    try {
      const crawl = await startProjectCrawl(createdProject.id);
      if (!crawl.ok) {
        setCrawlError(crawl.message);
        return;
      }
      router.push(`/dashboard/${createdProject.id}`);
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  if (createdProject) {
    return (
      <section className="rounded-lg border border-line bg-panel p-6" aria-live="polite">
        <h2 className="text-lg font-semibold">Site added: {createdProject.domain}</h2>
        {crawlError ? (
          <p role="alert" className="mt-2 text-sm text-critical">
            The site was created, but the first crawl could not be confirmed: {crawlError}
          </p>
        ) : (
          <p className="mt-2 text-sm text-slate-700">
            The first crawl was accepted and is running. Findings will appear after it finishes.
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-4">
          {crawlError && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void retryFirstCrawl()}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              {loading ? "Retrying…" : "Retry first crawl"}
            </button>
          )}
          <Link href={`/dashboard/${createdProject.id}`} className="text-sm text-primary underline">
            Open site
          </Link>
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      {needsWorkspaceSelection && (
        <form
          onSubmit={(e) => {
            void activateWorkspace(e);
          }}
          className="rounded-lg border border-line bg-panel p-6"
        >
          <h2 className="text-lg font-semibold">Choose a workspace</h2>
          <p className="mt-1 text-sm text-slate-700">
            Select which workspace to open. Membership is verified by the service.
          </p>
          {organizations.length > 1 ? (
            <label className="mt-4 block text-sm font-medium" htmlFor="active-workspace">
              Workspace
              <select
                id="active-workspace"
                required
                disabled={projectRetry !== null || !attemptReady}
                value={selectedOrgId}
                onChange={(e) => {
                  setSelectedOrgId(e.target.value);
                }}
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2"
              >
                <option value="">Choose a workspace</option>
                {organizations.map((organization) => (
                  <option key={organization.id} value={organization.id}>
                    {organization.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="mt-3 text-sm">{organizations[0]?.name ?? "No workspace available"}</p>
          )}
          {workspaceError && (
            <p role="alert" className="mt-3 text-sm text-critical">
              {workspaceError}
            </p>
          )}
          <button
            type="submit"
            disabled={workspaceLoading || organizations.length === 0}
            className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {workspaceLoading ? "Opening…" : "Open workspace"}
          </button>
        </form>
      )}

      <form
        onSubmit={(e) => {
          void submit(e);
        }}
        className="rounded-lg border border-line bg-panel p-6"
      >
        <h2 className="text-lg font-semibold">Add a site</h2>
        <p className="mt-1 text-sm text-slate-700">
          We’ll start a bounded site crawl after the site is created. Public pages are checked under
          robots.txt and findings keep their source URL and evidence. Search Console is optional.
        </p>
        {organizations.length > 1 && (
          <label className="mt-4 block text-sm font-medium" htmlFor="project-workspace">
            Add this site to
            <select
              id="project-workspace"
              required
              disabled={projectRetry !== null || !attemptReady}
              value={selectedOrgId}
              onChange={(e) => {
                setSelectedOrgId(e.target.value);
              }}
              className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2"
            >
              <option value="">Choose a workspace</option>
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <label htmlFor="domain" className="sr-only">
            Domain to audit
          </label>
          <input
            id="domain"
            name="domain"
            type="text"
            disabled={projectRetry !== null || !attemptReady}
            value={domain}
            onChange={(e) => {
              setDomain(e.target.value);
            }}
            placeholder="https://example.com"
            className="flex-1 rounded-lg border border-line bg-surface px-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            type="submit"
            disabled={loading || !attemptReady}
            className="rounded-lg bg-primary px-5 py-2 font-medium text-white transition hover:bg-primary/90 disabled:opacity-60"
          >
            {loading
              ? projectRetry
                ? "Retrying project creation…"
                : "Creating and crawling…"
              : projectRetry
                ? "Retry same site"
                : "Add & crawl"}
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-critical">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
