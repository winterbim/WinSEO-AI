import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./server.ts";

function sessionCookie(response: Awaited<ReturnType<FastifyInstance["inject"]>>): string {
  const header = response.headers["set-cookie"];
  const raw = typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined;
  return /serpvera_session=([^;]+)/.exec(raw ?? "")?.[1] ?? "";
}

void describe("project creation idempotency (memory adapter)", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp({ driver: "memory" });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  void it("retries a common workspace slug and replays projects by tenant and payload", async () => {
    const registration = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: `idempotency-${process.pid}@test.local`, password: "idempotency-pass-123" },
    });
    assert.equal(registration.statusCode, 201, registration.body);
    const cookie = sessionCookie(registration);

    const reserved = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      headers: { cookie: `serpvera_session=${cookie}` },
      payload: { name: "Reserved workspace", slug: "my-workspace" },
    });
    assert.equal(reserved.statusCode, 201, reserved.body);

    const firstWorkspace = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      headers: { cookie: `serpvera_session=${cookie}` },
      payload: { name: "My workspace" },
    });
    assert.equal(firstWorkspace.statusCode, 201, firstWorkspace.body);
    const firstWorkspaceSlug = (
      JSON.parse(firstWorkspace.body) as { organization: { slug: string } }
    ).organization.slug;
    assert.equal(firstWorkspaceSlug, "my-workspace-2");

    const organizationId = (JSON.parse(firstWorkspace.body) as { organization: { id: string } })
      .organization.id;
    const projectPayload = { organizationId, primaryDomain: "example.test" };
    const key = "62bf2c1c-290a-43b5-91eb-6e22fc0e66f1";
    const create = (payload: typeof projectPayload, idempotencyKey?: string) =>
      app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: {
          cookie: `serpvera_session=${cookie}`,
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        payload,
      });

    const invalidUrl = await create(
      { ...projectPayload, primaryDomain: "https://example.test/private/page" },
      "a770d242-9700-4cd0-824e-2e798b2a67d7",
    );
    assert.equal(invalidUrl.statusCode, 400, invalidUrl.body);
    assert.equal(
      (await app.stores.projects.listProjects(organizationId)).length,
      0,
      "invalid page URLs must be rejected before a project is persisted",
    );

    const original = await create(projectPayload, key);
    assert.equal(original.statusCode, 201, original.body);
    const originalId = (JSON.parse(original.body) as { project: { id: string } }).project.id;

    const replay = await create(projectPayload, key);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal((JSON.parse(replay.body) as { project: { id: string } }).project.id, originalId);

    const conflict = await create({ ...projectPayload, primaryDomain: "different.test" }, key);
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(
      (JSON.parse(conflict.body) as { error: { code: string } }).error.code,
      "IDEMPOTENCY_KEY_REUSED",
    );

    const legacyA = await create(projectPayload);
    const legacyB = await create(projectPayload);
    assert.equal(legacyA.statusCode, 201, legacyA.body);
    assert.equal(legacyB.statusCode, 201, legacyB.body);
    assert.notEqual(
      (JSON.parse(legacyA.body) as { project: { id: string } }).project.id,
      (JSON.parse(legacyB.body) as { project: { id: string } }).project.id,
    );
  });
});
