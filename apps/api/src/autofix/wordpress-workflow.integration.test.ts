import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createWordPressFixture,
  WORDPRESS_FIXTURE_TITLE_TARGET,
  WORDPRESS_FIXTURE_URL,
} from "./fixture-wordpress.ts";
import {
  fixtureStepUpProof,
  ProvenPatchWorkflow,
  sha256,
  type PatchActor,
  type PatchEvidence,
} from "./workflow.ts";

const ORGANIZATION_ID = "org-wp-fixture";
const PROJECT_ID = "project-wp-fixture";
const ACTOR: PatchActor = {
  organizationId: ORGANIZATION_ID,
  userId: "wp-reviewer",
  email: "reviewer@fixture.test",
};

void describe("WordPress REST simulator end-to-end proof loop", () => {
  void it("publishes R0 alt through REST, verifies R1 manual title, and restores the initial hash", async () => {
    let tick = Date.now() - 60_000;
    const clock = () => new Date((tick += 10));
    const { page, wordpress, simulator } = createWordPressFixture(clock);
    const workflow = new ProvenPatchWorkflow(page, clock);
    const initialResponse = await page.read(WORDPRESS_FIXTURE_URL, "browser", "raw");
    const initialHash = sha256(initialResponse.html);

    const evidenceFor = (html: string, extra: Partial<PatchEvidence> = {}): PatchEvidence => ({
      url: WORDPRESS_FIXTURE_URL,
      capturedAt: clock().toISOString(),
      rawHtml: html,
      contentHash: sha256(html),
      visibleText: "Ceramic dripper brewing guide for home kitchens.",
      ...extra,
    });

    const altEvidence = evidenceFor(initialResponse.html, {
      visualReview: { role: "informative", description: "Ceramic dripper" },
    });
    const altProposal = await workflow.propose({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      findingId: "finding-wp-alt",
      evidence: altEvidence,
      change: {
        field: "image_alt",
        before: "",
        after: "Ceramic dripper",
        imageId: "hero",
        imageRole: "informative",
      },
    });
    const altPreview = await workflow.preview(ORGANIZATION_ID, altProposal.id);
    assert.equal(altPreview.mode, "simulated");
    assert.match(altPreview.afterHtml, /alt="Ceramic dripper"/);
    workflow.approve(ORGANIZATION_ID, altProposal.id, ACTOR, altPreview.contentHash);
    const deployed = await workflow.deploy(
      ORGANIZATION_ID,
      altProposal.id,
      ACTOR,
      fixtureStepUpProof(ACTOR.userId, new Date(Date.now() - 2_000).toISOString()),
    );
    assert.equal(deployed.status, "deployed");
    assert.equal(deployed.deployment?.receiptHash, sha256(altPreview.afterHtml));
    const liveAlt = await workflow.verify(ORGANIZATION_ID, altProposal.id);
    assert.equal(liveAlt.status, "live_verified");
    const altVerification = liveAlt.verification;
    assert.ok(altVerification);
    assert.equal(altVerification.observations.length, 4);
    assert.ok(
      altVerification.observations.every((observation) => observation.value === "Ceramic dripper"),
    );
    assert.equal(simulator.mediaAlt, "Ceramic dripper");

    const restoredAlt = await workflow.rollback(ORGANIZATION_ID, altProposal.id);
    assert.equal(restoredAlt.status, "rolled_back");
    assert.equal(restoredAlt.verification?.verdict, "pass");
    assert.equal(simulator.mediaAlt, "");

    const titleBefore = await page.read(WORDPRESS_FIXTURE_URL, "browser", "raw");
    const titleEvidence = evidenceFor(titleBefore.html);
    const titleProposal = await workflow.propose({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      findingId: "finding-wp-title",
      evidence: titleEvidence,
      change: {
        field: "title",
        before: "Coffee brewing",
        after: "Ceramic dripper brewing guide",
      },
    });
    const titlePreview = await workflow.preview(ORGANIZATION_ID, titleProposal.id);
    workflow.approve(ORGANIZATION_ID, titleProposal.id, ACTOR, titlePreview.contentHash);
    const manual = await workflow.deployManually(
      ORGANIZATION_ID,
      titleProposal.id,
      ACTOR,
      fixtureStepUpProof(ACTOR.userId, new Date(Date.now() - 2_000).toISOString()),
    );
    assert.equal(manual.status, "deployed_manually");
    assert.equal(manual.deployment?.receiptHash, null);

    const waitingForManualWrite = await workflow.verify(ORGANIZATION_ID, titleProposal.id);
    assert.equal(waitingForManualWrite.status, "deployed_manually");
    assert.equal(waitingForManualWrite.verification?.verdict, "fail");

    const liveSource = await wordpress.read(WORDPRESS_FIXTURE_TITLE_TARGET);
    await wordpress.apply(
      WORDPRESS_FIXTURE_TITLE_TARGET,
      liveSource.hash,
      "Ceramic dripper brewing guide",
    );
    const liveTitle = await workflow.verify(ORGANIZATION_ID, titleProposal.id);
    assert.equal(liveTitle.status, "live_verified");
    assert.equal(liveTitle.verification?.verdict, "pass");
    const restoredTitle = await workflow.rollback(ORGANIZATION_ID, titleProposal.id);
    assert.equal(restoredTitle.status, "rolled_back");
    assert.equal(simulator.seoTitle, "Coffee brewing");

    const finalResponse = await page.read(WORDPRESS_FIXTURE_URL, "googlebot", "rendered");
    assert.equal(sha256(finalResponse.html), initialHash);
    assert.ok(simulator.requests.some((request) => request.method === "OPTIONS"));
    assert.ok(simulator.requests.some((request) => request.method === "POST"));
    assert.ok(simulator.requests.every((request) => request.authorized));
  });
});
