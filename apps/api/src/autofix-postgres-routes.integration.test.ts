import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { withAdmin } from "@serpvera/db";
import type { FastifyInstance } from "fastify";
import type { Response } from "light-my-request";
import { fixtureTotpCode } from "./auth/totp.ts";
import {
  createWordPressFixture,
  WORDPRESS_FIXTURE_TITLE_TARGET,
  WORDPRESS_FIXTURE_URL,
} from "./autofix/fixture-wordpress.ts";
import { sha256 } from "./autofix/workflow.ts";
import { buildApp } from "./server.ts";

const TAG = `wpflow${process.pid}${(Date.now() % 100_000).toString(36)}`;
const PASSWORD = "wpflow-local-pw-123";

function sessionOf(response: Response): string {
  const header = response.headers["set-cookie"];
  const raw = typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined;
  return /serpvera_session=([^;]+)/.exec(raw ?? "")?.[1] ?? "";
}

void describe("PostgreSQL API + WordPress REST simulator patch loop", () => {
  let app: FastifyInstance;
  let ownerUserId = "";
  let ownerOrganizationId = "";
  let ownerCookie = "";
  let foreignUserId = "";
  let foreignOrganizationId = "";
  let foreignCookie = "";
  const clock = (() => {
    let tick = Date.now();
    return () => {
      tick = Math.max(tick + 50, Date.now());
      return new Date(tick);
    };
  })();
  const { page, wordpress, simulator } = createWordPressFixture(clock);

  async function createTenant(tag: string) {
    const email = `${tag}-${TAG}@test.local`;
    const register = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password: PASSWORD },
    });
    assert.equal(register.statusCode, 201, register.body);
    const baseCookie = sessionOf(register);
    const user = await app.stores.users.findByEmail(email);
    assert.ok(user);

    const organizationResponse = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      headers: { cookie: `serpvera_session=${baseCookie}` },
      payload: { name: `WordPress ${tag} ${TAG}`, slug: `wp-${tag}-${TAG}` },
    });
    assert.equal(organizationResponse.statusCode, 201, organizationResponse.body);
    const organizationId = (
      JSON.parse(organizationResponse.body) as { organization: { id: string } }
    ).organization.id;
    const selected = await app.inject({
      method: "POST",
      url: "/v1/auth/select-organization",
      headers: { cookie: `serpvera_session=${baseCookie}` },
      payload: { organizationId },
    });
    assert.equal(selected.statusCode, 200, selected.body);
    return { userId: user.id, organizationId, cookie: sessionOf(selected) };
  }

  before(async () => {
    app = await buildApp({
      driver: "postgres",
      runtimeRole: "serpvera_app",
      fixturePageAdapter: page,
    });
    await app.ready();
    const owner = await createTenant("owner");
    ownerUserId = owner.userId;
    ownerOrganizationId = owner.organizationId;
    ownerCookie = owner.cookie;
    const foreign = await createTenant("foreign");
    foreignUserId = foreign.userId;
    foreignOrganizationId = foreign.organizationId;
    foreignCookie = foreign.cookie;
  });

  after(async () => {
    await withAdmin(async (client) => {
      if (ownerOrganizationId) {
        await client.query("DELETE FROM organizations WHERE id = $1", [ownerOrganizationId]);
      }
      if (foreignOrganizationId) {
        await client.query("DELETE FROM organizations WHERE id = $1", [foreignOrganizationId]);
      }
      const userIds = [ownerUserId, foreignUserId].filter(Boolean);
      if (userIds.length)
        await client.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
    });
    await app.close();
  });

  void it("explores, persists, publishes, verifies, and rolls back R0 and R1 patches", async () => {
    const projectResponse = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie: `serpvera_session=${ownerCookie}` },
      payload: {
        organizationId: ownerOrganizationId,
        name: "WordPress fixture",
        primaryDomain: "wp.fixture.test",
      },
    });
    assert.equal(projectResponse.statusCode, 201, projectResponse.body);
    const projectId = (JSON.parse(projectResponse.body) as { project: { id: string } }).project.id;
    const initial = await page.read(WORDPRESS_FIXTURE_URL, "browser", "raw");
    const initialHash = sha256(initial.html);

    const create = async (field: "image_alt" | "title") => {
      const response = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/autofix/demo`,
        headers: { cookie: `serpvera_session=${ownerCookie}` },
        payload: { field },
      });
      assert.equal(response.statusCode, 201, response.body);
      return (
        JSON.parse(response.body) as {
          patch: {
            id: string;
            version: number;
            status: string;
            contentHash: string;
            risk: string;
            change: { after: string };
          };
        }
      ).patch;
    };
    const previewAndApprove = async (patch: {
      id: string;
      version: number;
      contentHash: string;
    }) => {
      const previewResponse = await app.inject({
        method: "POST",
        url: `/v1/autofix/${patch.id}/preview`,
        headers: { cookie: `serpvera_session=${ownerCookie}` },
        payload: { expectedVersion: patch.version },
      });
      assert.equal(previewResponse.statusCode, 200, previewResponse.body);
      const preview = (JSON.parse(previewResponse.body) as { patch: { version: number } }).patch;
      const approval = await app.inject({
        method: "POST",
        url: `/v1/autofix/${patch.id}/approve`,
        headers: { cookie: `serpvera_session=${ownerCookie}` },
        payload: { expectedVersion: preview.version, contentHash: patch.contentHash },
      });
      assert.equal(approval.statusCode, 200, approval.body);
      return (JSON.parse(approval.body) as { patch: { version: number } }).patch;
    };

    const mfa = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/enroll",
      headers: { cookie: `serpvera_session=${ownerCookie}` },
      payload: { password: PASSWORD },
    });
    assert.equal(mfa.statusCode, 200, mfa.body);
    const secret = (JSON.parse(mfa.body) as { secret: string }).secret;
    const counter = Math.floor(Date.now() / 30_000);
    const confirmation = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/confirm-enrollment",
      headers: { cookie: `serpvera_session=${ownerCookie}` },
      payload: { code: fixtureTotpCode(secret, counter - 1) },
    });
    assert.equal(confirmation.statusCode, 200, confirmation.body);

    const altProposal = await create("image_alt");
    assert.equal(altProposal.status, "proposed");
    assert.equal(altProposal.risk, "R0");
    const altApproved = await previewAndApprove(altProposal);
    const altDeploy = await app.inject({
      method: "POST",
      url: `/v1/autofix/${altProposal.id}/deploy`,
      headers: { cookie: `serpvera_session=${ownerCookie}` },
      payload: { expectedVersion: altApproved.version, code: fixtureTotpCode(secret, counter) },
    });
    assert.equal(altDeploy.statusCode, 200, altDeploy.body);
    const altDeployed = (JSON.parse(altDeploy.body) as { patch: { version: number } }).patch;
    const altVerificationResponse = await app.inject({
      method: "POST",
      url: `/v1/autofix/${altProposal.id}/verify`,
      headers: { cookie: `serpvera_session=${ownerCookie}` },
      payload: { expectedVersion: altDeployed.version },
    });
    assert.equal(altVerificationResponse.statusCode, 200, altVerificationResponse.body);
    const altVerified = (
      JSON.parse(altVerificationResponse.body) as {
        patch: {
          status: string;
          version: number;
          verification: { verdict: string; observations: { contentHash: string | null }[] };
        };
      }
    ).patch;
    assert.equal(altVerified.status, "live_verified");
    assert.equal(altVerified.verification.verdict, "pass");
    assert.ok(
      altVerified.verification.observations.every((observation) => observation.contentHash),
    );

    const rollbackAlt = await app.inject({
      method: "POST",
      url: `/v1/autofix/${altProposal.id}/rollback`,
      headers: { cookie: `serpvera_session=${ownerCookie}` },
      payload: { expectedVersion: altVerified.version, code: fixtureTotpCode(secret, counter) },
    });
    assert.equal(rollbackAlt.statusCode, 200, rollbackAlt.body);
    assert.equal(
      (JSON.parse(rollbackAlt.body) as { patch: { status: string } }).patch.status,
      "rolled_back",
    );

    const titleProposal = await create("title");
    assert.equal(titleProposal.risk, "R1");
    const titleApproved = await previewAndApprove(titleProposal);
    const manual = await app.inject({
      method: "POST",
      url: `/v1/autofix/${titleProposal.id}/manual`,
      headers: { cookie: `serpvera_session=${ownerCookie}` },
      payload: { expectedVersion: titleApproved.version, code: fixtureTotpCode(secret, counter) },
    });
    assert.equal(manual.statusCode, 200, manual.body);
    const manualPatch = (
      JSON.parse(manual.body) as {
        patch: { version: number; status: string; deployment: { receiptHash: string | null } };
      }
    ).patch;
    assert.equal(manualPatch.status, "deployed_manually");
    assert.equal(manualPatch.deployment.receiptHash, null);

    const beforeWrite = await app.inject({
      method: "POST",
      url: `/v1/autofix/${titleProposal.id}/verify`,
      headers: { cookie: `serpvera_session=${ownerCookie}` },
      payload: { expectedVersion: manualPatch.version },
    });
    assert.equal(beforeWrite.statusCode, 200, beforeWrite.body);
    const waiting = (
      JSON.parse(beforeWrite.body) as {
        patch: { version: number; status: string; verification: { verdict: string } };
      }
    ).patch;
    assert.equal(waiting.status, "deployed_manually");
    assert.equal(waiting.verification.verdict, "fail");

    const currentTitle = await wordpress.read(WORDPRESS_FIXTURE_TITLE_TARGET);
    await wordpress.apply(
      WORDPRESS_FIXTURE_TITLE_TARGET,
      currentTitle.hash,
      titleProposal.change.after,
    );
    const verifyTitle = await app.inject({
      method: "POST",
      url: `/v1/autofix/${titleProposal.id}/verify`,
      headers: { cookie: `serpvera_session=${ownerCookie}` },
      payload: { expectedVersion: waiting.version },
    });
    assert.equal(verifyTitle.statusCode, 200, verifyTitle.body);
    const titleVerified = (
      JSON.parse(verifyTitle.body) as {
        patch: { status: string; version: number; verification: { verdict: string } };
      }
    ).patch;
    assert.equal(titleVerified.status, "live_verified");
    assert.equal(titleVerified.verification.verdict, "pass");

    const rollbackTitle = await app.inject({
      method: "POST",
      url: `/v1/autofix/${titleProposal.id}/rollback`,
      headers: { cookie: `serpvera_session=${ownerCookie}` },
      payload: { expectedVersion: titleVerified.version, code: fixtureTotpCode(secret, counter) },
    });
    assert.equal(rollbackTitle.statusCode, 200, rollbackTitle.body);
    assert.equal(
      (JSON.parse(rollbackTitle.body) as { patch: { status: string } }).patch.status,
      "rolled_back",
    );

    const finalPage = await page.read(WORDPRESS_FIXTURE_URL, "googlebot", "rendered");
    assert.equal(sha256(finalPage.html), initialHash);
    assert.ok(simulator.requests.some((request) => request.method === "OPTIONS"));
    assert.ok(simulator.requests.some((request) => request.method === "POST"));
    assert.ok(simulator.requests.every((request) => request.authorized));

    const list = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/autofix/patches`,
      headers: { cookie: `serpvera_session=${ownerCookie}` },
    });
    assert.equal(list.statusCode, 200, list.body);
    const stored = (
      JSON.parse(list.body) as { patches: { id: string; status: string; events: unknown[] }[] }
    ).patches;
    assert.equal(stored.length, 2);
    assert.ok(stored.every((patch) => patch.status === "rolled_back" && patch.events.length >= 6));

    const foreignPatch = await app.inject({
      method: "GET",
      url: `/v1/autofix/${altProposal.id}`,
      headers: { cookie: `serpvera_session=${foreignCookie}` },
    });
    assert.equal(foreignPatch.statusCode, 404);
  });
});
