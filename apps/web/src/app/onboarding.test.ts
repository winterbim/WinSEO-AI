import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startProjectCrawl } from "./dashboard/crawl-kickoff.ts";
import {
  clearPendingProjectCreation,
  normalizeProjectDomain,
  postProjectCreation,
  readPendingProjectCreation,
  savePendingProjectCreation,
} from "./dashboard/project-creation.ts";
import { resolveWorkspaceChoice } from "./dashboard/workspace-selection.ts";
import { authModeFromQuery, safeNextPath } from "./login/auth-params.ts";
import { signupRedirectUrl } from "./signup/signup-redirect.ts";

void describe("signup route helpers", () => {
  void it("routes into registration and preserves a plan reference safely", () => {
    const url = new URL(signupRedirectUrl("growth plus"), "https://serpvera.test");
    assert.equal(url.pathname, "/login");
    assert.equal(url.searchParams.get("mode"), "register");
    assert.equal(url.searchParams.get("plan"), "growth plus");
  });

  void it("does not add a plan when no plan was requested", () => {
    const url = new URL(signupRedirectUrl(undefined), "https://serpvera.test");
    assert.equal(url.searchParams.get("mode"), "register");
    assert.equal(url.searchParams.has("plan"), false);
  });

  void it("preserves the requested destination through the signup route", () => {
    const url = new URL(
      signupRedirectUrl(undefined, "/dashboard/security?tab=team"),
      "https://serpvera.test",
    );
    assert.equal(url.searchParams.get("next"), "/dashboard/security?tab=team");
  });

  void it("preselects registration for signup links and sign-in otherwise", () => {
    assert.equal(authModeFromQuery("register"), "register");
    assert.equal(authModeFromQuery(null), "login");
    assert.equal(authModeFromQuery("login"), "login");
  });

  void it("allows same-origin local destinations and falls back for unsafe values", () => {
    assert.equal(
      safeNextPath("/dashboard/security?tab=team#members"),
      "/dashboard/security?tab=team#members",
    );
    assert.equal(safeNextPath(null), "/dashboard");
    assert.equal(safeNextPath("https://outside.test/"), "/dashboard");
    assert.equal(safeNextPath("//outside.test/"), "/dashboard");
    assert.equal(safeNextPath("/\\\\outside.test/"), "/dashboard");
    assert.equal(safeNextPath("javascript:alert(1)"), "/dashboard");
    assert.equal(safeNextPath("/%2e%2e//evil.example"), "/dashboard");
    assert.equal(safeNextPath("/%252e%252e//evil.example"), "/dashboard");
    assert.equal(safeNextPath("/safe/%2e%2e/route"), "/dashboard");
    assert.equal(safeNextPath("/%2f%2fevil.example"), "/dashboard");
  });
});

void describe("workspace destination selection", () => {
  const workspaces = [
    { id: "workspace-a", name: "A" },
    { id: "workspace-b", name: "B" },
  ];
  const workspaceA = { id: "workspace-a", name: "A" };

  void it("requires an explicit destination when multiple workspaces exist", () => {
    assert.deepEqual(resolveWorkspaceChoice(workspaces, ""), { kind: "choose" });
    assert.deepEqual(resolveWorkspaceChoice(workspaces, "workspace-b"), {
      kind: "selected",
      workspace: workspaces[1],
    });
    assert.deepEqual(resolveWorkspaceChoice(workspaces, "not-a-member"), { kind: "choose" });
  });

  void it("uses the only workspace or signals first-workspace setup", () => {
    assert.deepEqual(resolveWorkspaceChoice([workspaceA], ""), {
      kind: "selected",
      workspace: workspaceA,
    });
    assert.deepEqual(resolveWorkspaceChoice([], ""), { kind: "create" });
  });
});

void describe("project creation retries", () => {
  void it("normalizes domain and homepage inputs while rejecting page paths and unsafe schemes", () => {
    assert.deepEqual(normalizeProjectDomain(" example.com "), {
      ok: true,
      primaryDomain: "example.com",
    });
    assert.deepEqual(normalizeProjectDomain("HTTPS://Example.com/"), {
      ok: true,
      primaryDomain: "example.com",
    });
    assert.equal(normalizeProjectDomain("example.com/blog").ok, false);
    assert.equal(normalizeProjectDomain("https://example.com/?q=test").ok, false);
    assert.equal(normalizeProjectDomain("javascript://example.com").ok, false);
    assert.equal(normalizeProjectDomain("https://user:secret@example.com").ok, false);
  });

  void it("persists the same key and payload across a page retry", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const attempt = {
      idempotencyKey: "a2dd90fb-15ca-4127-8eab-0f34e6d5a001",
      organizationId: "workspace-1",
      name: "example.com",
      primaryDomain: "example.com",
    };

    savePendingProjectCreation(storage, attempt);
    assert.deepEqual(readPendingProjectCreation(storage), attempt);
    clearPendingProjectCreation(storage);
    assert.equal(readPendingProjectCreation(storage), null);
  });

  void it("sends the same idempotency key and payload on every retry", async () => {
    const keys: string[] = [];
    const bodies: string[] = [];
    const fetcher: typeof fetch = (_input, init) => {
      keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      const body = init?.body;
      bodies.push(typeof body === "string" ? body : "");
      return Promise.resolve(Response.json({ project: { id: "project-1" } }, { status: 201 }));
    };
    const payload = {
      organizationId: "workspace-1",
      name: "example.com",
      primaryDomain: "example.com",
    };
    const key = "a2dd90fb-15ca-4127-8eab-0f34e6d5a001";

    await postProjectCreation(payload, key, fetcher);
    await postProjectCreation(payload, key, fetcher);

    assert.deepEqual(keys, [key, key]);
    assert.deepEqual(bodies, [JSON.stringify(payload), JSON.stringify(payload)]);
  });
});

void describe("startProjectCrawl", () => {
  void it("posts to the project's crawl route", async () => {
    let requestedUrl = "";
    let requestedMethod = "";
    const result = await startProjectCrawl("project-1", (input, init) => {
      requestedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requestedMethod = init?.method ?? "";
      return Promise.resolve(
        Response.json(
          { crawlRun: { id: "run-1", projectId: "project-1", status: "running" } },
          { status: 201 },
        ),
      );
    });

    assert.deepEqual(result, {
      ok: true,
      crawlRun: { id: "run-1", projectId: "project-1", status: "running" },
    });
    assert.equal(requestedUrl, "/api/v1/projects/project-1/crawl-runs");
    assert.equal(requestedMethod, "POST");
  });

  void it("returns the API's actionable error when kickoff is rejected", async () => {
    const result = await startProjectCrawl("project-1", () =>
      Promise.resolve(
        Response.json({ error: { message: "Domain is not reachable." } }, { status: 400 }),
      ),
    );

    assert.deepEqual(result, { ok: false, message: "Domain is not reachable." });
  });

  void it("returns a retryable message when the request has no response", async () => {
    const result = await startProjectCrawl("project-1", () => {
      throw new Error("offline");
    });

    assert.deepEqual(result, {
      ok: false,
      message:
        "Could not confirm whether the crawl started. Check the site before retrying; the request may have reached the service.",
    });
  });
});
