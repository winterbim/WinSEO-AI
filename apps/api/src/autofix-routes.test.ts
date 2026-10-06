import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./server.ts";
import type { FastifyInstance } from "fastify";
import type { Response } from "light-my-request";
import { fixtureTotpCode } from "./auth/totp.ts";

const TAG = `autofix${process.pid}${(Date.now() % 100_000).toString(36)}`;
const PASSWORD = "autofix-local-pw-123";

function sessionOf(response: Response): string {
  const header = response.headers["set-cookie"];
  const raw = typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined;
  return /serpvera_session=([^;]+)/.exec(raw ?? "")?.[1] ?? "";
}

void describe("fixture-backed proven patch routes", () => {
  let app: FastifyInstance;

  async function inject(method: "GET" | "POST", url: string, cookie?: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      ...(cookie ? { headers: { cookie: `serpvera_session=${cookie}` } } : {}),
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  }

  async function tenant(tag: string) {
    const register = await inject("POST", "/v1/auth/register", undefined, {
      email: `${tag}-${TAG}@test.local`,
      password: PASSWORD,
    });
    assert.equal(register.statusCode, 201, register.body);
    const baseCookie = sessionOf(register);
    const organization = await inject("POST", "/v1/organizations", baseCookie, {
      name: `AutoFix ${tag} ${TAG}`,
      slug: `autofix-${tag}-${TAG}`,
    });
    assert.equal(organization.statusCode, 201, organization.body);
    const organizationId = (JSON.parse(organization.body) as { organization: { id: string } })
      .organization.id;
    const selected = await inject("POST", "/v1/auth/select-organization", baseCookie, {
      organizationId,
    });
    assert.equal(selected.statusCode, 200, selected.body);
    return { organizationId, cookie: sessionOf(selected) };
  }

  before(async () => {
    app = await buildApp({ driver: "memory" });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  void it("persists an isolated R0 fixture proposal through hash approval, step-up, verification, and rollback", async () => {
    const a = await tenant("a");
    const b = await tenant("b");
    const projectResponse = await inject("POST", "/v1/projects", a.cookie, {
      organizationId: a.organizationId,
      name: "Fixture site",
      primaryDomain: "example.test",
    });
    assert.equal(projectResponse.statusCode, 201, projectResponse.body);
    const projectId = (JSON.parse(projectResponse.body) as { project: { id: string } }).project.id;

    const created = await inject("POST", `/v1/projects/${projectId}/autofix/demo`, a.cookie, {
      field: "image_alt",
    });
    assert.equal(created.statusCode, 201, created.body);
    const createdBody = JSON.parse(created.body) as {
      patch: { id: string; version: number; status: string; contentHash: string };
    };
    assert.equal(createdBody.patch.status, "proposed");
    assert.ok(
      !created.body.includes("<!doctype html>"),
      "raw evidence HTML must not be sent in proposal responses",
    );

    const foreign = await inject("GET", `/v1/autofix/${createdBody.patch.id}`, b.cookie);
    assert.equal(foreign.statusCode, 404);

    const previewResponse = await inject(
      "POST",
      `/v1/autofix/${createdBody.patch.id}/preview`,
      a.cookie,
      {
        expectedVersion: createdBody.patch.version,
      },
    );
    assert.equal(previewResponse.statusCode, 200, previewResponse.body);
    const preview = (
      JSON.parse(previewResponse.body) as {
        patch: { version: number; status: string; contentHash: string };
      }
    ).patch;
    assert.equal(preview.status, "previewed");

    const approveResponse = await inject(
      "POST",
      `/v1/autofix/${createdBody.patch.id}/approve`,
      a.cookie,
      {
        expectedVersion: preview.version,
        contentHash: createdBody.patch.contentHash,
      },
    );
    assert.equal(approveResponse.statusCode, 200, approveResponse.body);
    const approved = (
      JSON.parse(approveResponse.body) as { patch: { version: number; status: string } }
    ).patch;
    assert.equal(approved.status, "approved");

    const blocked = await inject("POST", `/v1/autofix/${createdBody.patch.id}/deploy`, a.cookie, {
      expectedVersion: approved.version,
      code: "123456",
    });
    assert.equal(blocked.statusCode, 403, blocked.body);
    assert.equal(
      (JSON.parse(blocked.body) as { error: { code: string } }).error.code,
      "MFA_REQUIRED",
    );

    const enrollment = await inject("POST", "/v1/auth/mfa/enroll", a.cookie, {
      password: PASSWORD,
    });
    assert.equal(enrollment.statusCode, 200, enrollment.body);
    const secret = (JSON.parse(enrollment.body) as { secret: string }).secret;
    const counter = Math.floor(Date.now() / 30_000);
    const confirm = await inject("POST", "/v1/auth/mfa/confirm-enrollment", a.cookie, {
      code: fixtureTotpCode(secret, counter - 1),
    });
    assert.equal(confirm.statusCode, 200, confirm.body);

    const deploy = await inject("POST", `/v1/autofix/${createdBody.patch.id}/deploy`, a.cookie, {
      expectedVersion: approved.version,
      code: fixtureTotpCode(secret, counter),
    });
    assert.equal(deploy.statusCode, 200, deploy.body);
    const deployed = (JSON.parse(deploy.body) as { patch: { version: number; status: string } })
      .patch;
    assert.equal(deployed.status, "deployed");

    const verify = await inject("POST", `/v1/autofix/${createdBody.patch.id}/verify`, a.cookie, {
      expectedVersion: deployed.version,
    });
    assert.equal(verify.statusCode, 200, verify.body);
    const verified = (
      JSON.parse(verify.body) as {
        patch: {
          version: number;
          status: string;
          verification: { verdict: string; observations: { contentHash: string | null }[] };
          evidence: { contentHash: string };
        };
      }
    ).patch;
    assert.equal(verified.status, "live_verified");
    assert.equal(verified.verification.verdict, "pass");
    assert.ok(
      verified.verification.observations.every((observation) => observation.contentHash !== null),
    );

    const rollback = await inject(
      "POST",
      `/v1/autofix/${createdBody.patch.id}/rollback`,
      a.cookie,
      {
        expectedVersion: verified.version,
        code: fixtureTotpCode(secret, counter),
      },
    );
    assert.equal(rollback.statusCode, 200, rollback.body);
    const restored = (
      JSON.parse(rollback.body) as {
        patch: {
          status: string;
          evidence: { contentHash: string };
          verification: { observations: { contentHash: string | null }[] };
          events: unknown[];
        };
      }
    ).patch;
    assert.equal(restored.status, "rolled_back");
    assert.equal(restored.verification.observations[0]?.contentHash, restored.evidence.contentHash);
    assert.ok(restored.events.length >= 6);

    const titleCreated = await inject("POST", `/v1/projects/${projectId}/autofix/demo`, a.cookie, {
      field: "title",
    });
    assert.equal(titleCreated.statusCode, 201, titleCreated.body);
    const titleProposal = (
      JSON.parse(titleCreated.body) as {
        patch: { id: string; version: number; status: string; contentHash: string; risk: string };
      }
    ).patch;
    assert.equal(titleProposal.risk, "R1");
    const titlePreviewResponse = await inject(
      "POST",
      `/v1/autofix/${titleProposal.id}/preview`,
      a.cookie,
      { expectedVersion: titleProposal.version },
    );
    assert.equal(titlePreviewResponse.statusCode, 200, titlePreviewResponse.body);
    const titlePreview = (JSON.parse(titlePreviewResponse.body) as { patch: { version: number } })
      .patch;
    const titleApproveResponse = await inject(
      "POST",
      `/v1/autofix/${titleProposal.id}/approve`,
      a.cookie,
      {
        expectedVersion: titlePreview.version,
        contentHash: titleProposal.contentHash,
      },
    );
    assert.equal(titleApproveResponse.statusCode, 200, titleApproveResponse.body);
    const titleApproved = (JSON.parse(titleApproveResponse.body) as { patch: { version: number } })
      .patch;
    const titleDeploy = await inject("POST", `/v1/autofix/${titleProposal.id}/deploy`, a.cookie, {
      expectedVersion: titleApproved.version,
      code: fixtureTotpCode(secret, counter),
    });
    assert.equal(titleDeploy.statusCode, 200, titleDeploy.body);
    const titleDeployed = (JSON.parse(titleDeploy.body) as { patch: { version: number } }).patch;
    const titleVerify = await inject("POST", `/v1/autofix/${titleProposal.id}/verify`, a.cookie, {
      expectedVersion: titleDeployed.version,
    });
    assert.equal(titleVerify.statusCode, 200, titleVerify.body);
    const titleVerified = (
      JSON.parse(titleVerify.body) as {
        patch: { version: number; status: string; verification: { verdict: string } };
      }
    ).patch;
    assert.equal(titleVerified.status, "live_verified");
    assert.equal(titleVerified.verification.verdict, "pass");
    const titleRollback = await inject(
      "POST",
      `/v1/autofix/${titleProposal.id}/rollback`,
      a.cookie,
      {
        expectedVersion: titleVerified.version,
        code: fixtureTotpCode(secret, counter),
      },
    );
    assert.equal(titleRollback.statusCode, 200, titleRollback.body);
    assert.equal(
      (JSON.parse(titleRollback.body) as { patch: { status: string } }).patch.status,
      "rolled_back",
    );
  });

  void it("requires step-up for manual publication and keeps an unobserved edit pending", async () => {
    const reviewer = await tenant("manual");
    const projectResponse = await inject("POST", "/v1/projects", reviewer.cookie, {
      organizationId: reviewer.organizationId,
      name: "Manual fixture site",
      primaryDomain: "manual.example.test",
    });
    assert.equal(projectResponse.statusCode, 201, projectResponse.body);
    const projectId = (JSON.parse(projectResponse.body) as { project: { id: string } }).project.id;
    const created = await inject(
      "POST",
      `/v1/projects/${projectId}/autofix/demo`,
      reviewer.cookie,
      {
        field: "title",
      },
    );
    assert.equal(created.statusCode, 201, created.body);
    const proposal = (
      JSON.parse(created.body) as {
        patch: { id: string; version: number; contentHash: string };
      }
    ).patch;
    const previewResponse = await inject(
      "POST",
      `/v1/autofix/${proposal.id}/preview`,
      reviewer.cookie,
      { expectedVersion: proposal.version },
    );
    assert.equal(previewResponse.statusCode, 200, previewResponse.body);
    const preview = (JSON.parse(previewResponse.body) as { patch: { version: number } }).patch;
    const approval = await inject("POST", `/v1/autofix/${proposal.id}/approve`, reviewer.cookie, {
      expectedVersion: preview.version,
      contentHash: proposal.contentHash,
    });
    assert.equal(approval.statusCode, 200, approval.body);
    const approved = (JSON.parse(approval.body) as { patch: { version: number } }).patch;

    const blocked = await inject("POST", `/v1/autofix/${proposal.id}/manual`, reviewer.cookie, {
      expectedVersion: approved.version,
      code: "123456",
    });
    assert.equal(blocked.statusCode, 403, blocked.body);
    assert.equal(
      (JSON.parse(blocked.body) as { error: { code: string } }).error.code,
      "MFA_REQUIRED",
    );

    const enrollment = await inject("POST", "/v1/auth/mfa/enroll", reviewer.cookie, {
      password: PASSWORD,
    });
    assert.equal(enrollment.statusCode, 200, enrollment.body);
    const secret = (JSON.parse(enrollment.body) as { secret: string }).secret;
    const counter = Math.floor(Date.now() / 30_000);
    const confirmed = await inject("POST", "/v1/auth/mfa/confirm-enrollment", reviewer.cookie, {
      code: fixtureTotpCode(secret, counter - 1),
    });
    assert.equal(confirmed.statusCode, 200, confirmed.body);

    const manual = await inject("POST", `/v1/autofix/${proposal.id}/manual`, reviewer.cookie, {
      expectedVersion: approved.version,
      code: fixtureTotpCode(secret, counter),
    });
    assert.equal(manual.statusCode, 200, manual.body);
    const declared = (
      JSON.parse(manual.body) as {
        patch: {
          id: string;
          version: number;
          status: string;
          deployment: { mode: string; receiptHash: string | null; instructions: string };
        };
      }
    ).patch;
    assert.equal(declared.status, "deployed_manually");
    assert.equal(declared.deployment.mode, "manual");
    assert.equal(declared.deployment.receiptHash, null);
    assert.match(declared.deployment.instructions, /manual declaration/);

    const verify = await inject("POST", `/v1/autofix/${proposal.id}/verify`, reviewer.cookie, {
      expectedVersion: declared.version,
    });
    assert.equal(verify.statusCode, 200, verify.body);
    const stillPending = (
      JSON.parse(verify.body) as {
        patch: { version: number; status: string; verification: { verdict: string } };
      }
    ).patch;
    assert.equal(stillPending.status, "deployed_manually");
    assert.equal(stillPending.verification.verdict, "fail");
  });
});
