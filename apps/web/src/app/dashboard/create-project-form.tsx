"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface OrgResponse {
  organizations: { id: string; name: string }[];
}
interface ProjectResponse {
  project: { id: string };
}
interface ErrResponse {
  error?: { message?: string };
}

async function readErr(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as ErrResponse;
  return body.error?.message ?? fallback;
}

export function CreateProjectForm() {
  const router = useRouter();
  const [domain, setDomain] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const clean = domain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!clean) {
      setError("Enter the domain of the site you want to audit.");
      return;
    }
    setLoading(true);
    try {
      // 1) Ensure an active organization: list → create if none → SELECT.
      //    select-organization is what puts the tenant into the session; the
      //    server derives the role from the membership row (never client input).
      const orgsRes = await fetch("/api/v1/organizations");
      if (!orgsRes.ok) {
        setError(await readErr(orgsRes, "Workspace lookup failed."));
        return;
      }
      const orgs = (await orgsRes.json()) as OrgResponse;

      let orgId = orgs.organizations[0]?.id;
      if (!orgId) {
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
      const projRes = await fetch("/api/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ primaryDomain: clean, organizationId: orgId }),
      });
      if (!projRes.ok) {
        setError(await readErr(projRes, "Could not create the project."));
        return;
      }
      const project = (await projRes.json()) as ProjectResponse;
      router.push(`/dashboard/${project.project.id}`);
      router.refresh();
    } catch {
      setError("The service is temporarily unavailable. Please retry.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        void submit(e);
      }}
      className="rounded-lg border border-line bg-panel p-6"
    >
      <h2 className="text-lg font-semibold">Add a site</h2>
      <p className="mt-1 text-sm text-slate-700">
        Its homepage is crawled by the deterministic rule engine; findings are persisted
        with evidence you can inspect.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <label htmlFor="domain" className="sr-only">
          Domain to audit
        </label>
        <input
          id="domain"
          name="domain"
          type="text"
          value={domain}
          onChange={(e) => { setDomain(e.target.value); }}
          placeholder="example.com"
          className="flex-1 rounded-lg border border-line bg-surface px-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-primary px-5 py-2 font-medium text-white transition hover:bg-primary/90 disabled:opacity-60"
        >
          {loading ? "Creating…" : "Add & crawl"}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-critical">
          {error}
        </p>
      )}
    </form>
  );
}