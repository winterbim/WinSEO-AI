import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryFixtureCms,
  PATCH_TRANSITIONS,
  PatchWorkflowError,
  ProvenPatchWorkflow,
  fixtureStepUpProof,
  sha256,
  type PatchActor,
  type PatchChange,
  type PatchEvidence,
} from "./workflow.ts";

const URL = "https://fixture.example/guide";
const ORG = "org-fixture";
const ACTOR: PatchActor = {
  organizationId: ORG,
  userId: "reviewer-1",
  email: "reviewer@fixture.test",
};
const recentStepUp = (actorId = ACTOR.userId) =>
  fixtureStepUpProof(actorId, new Date(Date.now() - 2_000).toISOString());
const BASE_HTML =
  '<!doctype html><html lang="en"><head><title>Coffee brewing</title><link rel="canonical" href="https://fixture.example/guide"></head><body><main><h1>Ceramic dripper brewing guide</h1><p>Ceramic dripper brewing guide for home kitchens.</p><img id="hero" src="/dripper.jpg" alt=""></main></body></html>';

function createFixture() {
  let tick = Date.now() - 1_000;
  const clock = () => new Date((tick += 1_000));
  const adapter = new InMemoryFixtureCms({ [URL]: BASE_HTML }, clock);
  const workflow = new ProvenPatchWorkflow(adapter, clock);
  const evidence: PatchEvidence = {
    url: URL,
    capturedAt: new Date(tick).toISOString(),
    rawHtml: BASE_HTML,
    contentHash: sha256(BASE_HTML),
    visibleText: "Ceramic dripper brewing guide for home kitchens.",
    visualReview: { role: "informative", description: "Ceramic dripper" },
  };
  const altChange: PatchChange = {
    field: "image_alt",
    before: "",
    after: "Ceramic dripper",
    imageId: "hero",
    imageRole: "informative",
  };
  const titleChange: PatchChange = {
    field: "title",
    before: "Coffee brewing",
    after: "Ceramic dripper brewing guide",
  };
  return { adapter, workflow, evidence, altChange, titleChange };
}

async function createPreviewed(
  workflow: ProvenPatchWorkflow,
  evidence: PatchEvidence,
  change: PatchChange,
) {
  const proposal = await workflow.propose({
    organizationId: ORG,
    projectId: "project-fixture",
    findingId: "finding-fixture",
    evidence,
    change,
  });
  const preview = await workflow.preview(ORG, proposal.id);
  return { proposal: workflow.get(ORG, proposal.id), preview };
}

void describe("proof-bound patch workflow (fixture only)", () => {
  void it("declares the complete lifecycle and blocks skipped proof states", () => {
    const lifecycle = [
      "detected",
      "proposed",
      "previewed",
      "approved",
      "deploying",
      "deployed",
      "live_verified",
      "google_observed",
      "measuring",
      "measured",
    ] as const;
    assert.deepEqual(
      Object.keys(PATCH_TRANSITIONS).sort(),
      [
        "approved",
        "deployed",
        "deployed_manually",
        "detected",
        "drifted",
        "failed",
        "google_observed",
        "live_verified",
        "measured",
        "measuring",
        "previewed",
        "proposed",
        "rejected",
        "rolled_back",
        "superseded",
        "deploying",
      ].sort(),
    );
    for (let index = 1; index < lifecycle.length; index += 1) {
      const from = lifecycle[index - 1];
      const to = lifecycle[index];
      if (!from || !to) throw new Error("Lifecycle path is incomplete.");
      assert.ok(PATCH_TRANSITIONS[from].includes(to), `${from} must allow ${to}`);
    }
    assert.ok(!PATCH_TRANSITIONS.proposed.includes("deployed"));
    assert.ok(!PATCH_TRANSITIONS.live_verified.includes("measured"));
    assert.ok(PATCH_TRANSITIONS.live_verified.includes("drifted"));
  });

  void it("refuses to construct the fixture workflow in production", () => {
    const { adapter } = createFixture();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      assert.throws(
        () => new ProvenPatchWorkflow(adapter),
        (error: unknown) => error instanceof PatchWorkflowError && error.code === "FIXTURE_ONLY",
      );
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  void it("runs an informative alt patch from evidence through verified rollback", async () => {
    const { workflow, evidence, altChange, adapter } = createFixture();
    const { proposal, preview } = await createPreviewed(workflow, evidence, altChange);
    assert.equal(proposal.status, "previewed");
    assert.equal(proposal.risk, "R0");
    assert.equal(preview.mode, "simulated");
    assert.match(preview.afterHtml, /alt="Ceramic dripper"/);
    assert.equal(preview.contentHash, proposal.contentHash);

    assert.throws(
      () => workflow.approve(ORG, proposal.id, ACTOR, "0".repeat(64)),
      (error: unknown) =>
        error instanceof PatchWorkflowError && error.code === "APPROVAL_HASH_MISMATCH",
    );
    workflow.approve(ORG, proposal.id, ACTOR, proposal.contentHash);
    await assert.rejects(
      workflow.deploy(ORG, proposal.id, ACTOR, recentStepUp("another-user")),
      (error: unknown) => error instanceof PatchWorkflowError && error.code === "STEP_UP_REQUIRED",
    );

    const deployed = await workflow.deploy(ORG, proposal.id, ACTOR, recentStepUp());
    assert.equal(deployed.status, "deployed");
    const deployment = deployed.deployment;
    assert.ok(deployment);
    assert.equal(deployment.receiptHash, sha256(preview.afterHtml));
    const live = await workflow.verify(ORG, proposal.id);
    assert.equal(live.status, "live_verified");
    const liveVerification = live.verifications[0];
    assert.ok(liveVerification);
    assert.equal(liveVerification.verdict, "pass");
    assert.equal(liveVerification.observations.length, 4);
    assert.ok(
      liveVerification.observations.every(
        (item) => Date.parse(item.observedAt) > Date.parse(deployment.at),
      ),
    );

    const undone = await workflow.rollback(ORG, proposal.id);
    assert.equal(undone.status, "rolled_back");
    const rollbackVerification = undone.verification;
    assert.ok(rollbackVerification);
    assert.equal(rollbackVerification.verdict, "pass");
    assert.ok(
      rollbackVerification.observations.every((item) => item.contentHash === evidence.contentHash),
    );
    assert.equal(sha256((await adapter.read(URL, "browser", "raw")).html), evidence.contentHash);
    assert.deepEqual(
      undone.events.map((event) => event.to),
      [
        "detected",
        "proposed",
        "previewed",
        "approved",
        "deploying",
        "deployed",
        "live_verified",
        "rolled_back",
      ],
    );
  });

  void it("supports an R1 title and manual publication without inventing a write receipt", async () => {
    const { workflow, evidence, titleChange, adapter } = createFixture();
    const { proposal } = await createPreviewed(workflow, evidence, titleChange);
    assert.equal(proposal.risk, "R1");
    workflow.approve(ORG, proposal.id, ACTOR, proposal.contentHash);
    const declared = await workflow.deployManually(ORG, proposal.id, ACTOR, recentStepUp());
    assert.equal(declared.status, "deployed_manually");
    const manualDeployment = declared.deployment;
    assert.ok(manualDeployment);
    assert.equal(manualDeployment.receiptHash, null);
    assert.match(manualDeployment.instructions ?? "", /manual declaration/);
    assert.equal((await adapter.read(URL, "browser", "raw")).html, BASE_HTML);

    adapter.externalWrite(URL, declared.preview?.afterHtml ?? "");
    const live = await workflow.verify(ORG, proposal.id);
    assert.equal(live.status, "live_verified");
    const manualVerification = live.verification;
    assert.ok(manualVerification);
    assert.equal(manualVerification.observations[0]?.value, titleChange.after);
    assert.equal((await workflow.rollback(ORG, proposal.id)).status, "rolled_back");
  });

  void it("rejects ungrounded text, decorative alt text, and every unsupported R2-shaped patch", async () => {
    const { workflow, evidence, altChange, titleChange } = createFixture();
    await assert.rejects(
      workflow.propose({
        organizationId: ORG,
        projectId: "p",
        findingId: "f",
        evidence: { ...evidence, visibleText: "Ceramic dripper" },
        change: { ...titleChange, after: "Best ceramic dripper sale 2026" },
      }),
      (error: unknown) => error instanceof PatchWorkflowError && error.code === "PATCH_UNGROUNDED",
    );
    await assert.rejects(
      workflow.propose({
        organizationId: ORG,
        projectId: "p",
        findingId: "f",
        evidence: { ...evidence, visualReview: { role: "decorative" } },
        change: {
          ...altChange,
          imageRole: "decorative",
          after: "Ceramic dripper",
        },
      }),
      (error: unknown) => error instanceof PatchWorkflowError && error.code === "PATCH_UNGROUNDED",
    );
    await assert.rejects(
      workflow.propose({
        organizationId: ORG,
        projectId: "p",
        findingId: "f",
        evidence,
        change: {
          field: "canonical",
          before: URL,
          after: "https://fixture.example/other",
        } as unknown as PatchChange,
      }),
      (error: unknown) => error instanceof PatchWorkflowError && error.code === "PATCH_UNSUPPORTED",
    );
  });

  void it("rolls back on browser/Googlebot divergence and records the failed proof", async () => {
    const { workflow, evidence, altChange, adapter } = createFixture();
    const { proposal } = await createPreviewed(workflow, evidence, altChange);
    workflow.approve(ORG, proposal.id, ACTOR, proposal.contentHash);
    const deployed = await workflow.deploy(ORG, proposal.id, ACTOR, recentStepUp());
    const divergent = deployed.preview?.afterHtml.replace(
      'alt="Ceramic dripper"',
      'alt="Wrong value"',
    );
    adapter.injectObservation(URL, "googlebot", "raw", {
      status: 200,
      html: divergent,
    });

    await assert.rejects(
      workflow.verify(ORG, proposal.id),
      (error: unknown) =>
        error instanceof PatchWorkflowError && error.code === "VERIFICATION_FAILED",
    );
    const after = workflow.get(ORG, proposal.id);
    assert.equal(after.status, "rolled_back");
    const failedVerification = after.verifications[0];
    assert.ok(failedVerification);
    assert.equal(failedVerification.verdict, "fail");
    assert.equal(
      failedVerification.observations.find(
        (item) => item.userAgent === "googlebot" && item.mode === "raw",
      )?.value,
      "Wrong value",
    );
    const rollbackVerification = after.verifications[1];
    assert.ok(rollbackVerification);
    assert.equal(rollbackVerification.verdict, "pass");
    assert.equal(sha256((await adapter.read(URL, "browser", "raw")).html), evidence.contentHash);
  });

  void it("treats a blocked Googlebot response as inconclusive and never as success", async () => {
    const { workflow, evidence, altChange, adapter } = createFixture();
    const { proposal } = await createPreviewed(workflow, evidence, altChange);
    workflow.approve(ORG, proposal.id, ACTOR, proposal.contentHash);
    await workflow.deploy(ORG, proposal.id, ACTOR, recentStepUp());
    adapter.injectObservation(URL, "googlebot", "raw", { status: 403 });
    await assert.rejects(workflow.verify(ORG, proposal.id));
    const result = workflow.get(ORG, proposal.id);
    assert.equal(result.status, "rolled_back");
    assert.equal(result.verifications[0]?.verdict, "inconclusive");
    assert.equal(result.verifications[1]?.verdict, "pass");
  });

  void it("refuses to overwrite a source change made after approval", async () => {
    const { workflow, evidence, altChange, adapter } = createFixture();
    const { proposal } = await createPreviewed(workflow, evidence, altChange);
    workflow.approve(ORG, proposal.id, ACTOR, proposal.contentHash);
    adapter.externalWrite(URL, BASE_HTML.replace("home kitchens", "home baristas"));
    await assert.rejects(
      workflow.deploy(ORG, proposal.id, ACTOR, recentStepUp()),
      (error: unknown) => error instanceof PatchWorkflowError && error.code === "SOURCE_CHANGED",
    );
    assert.equal(workflow.get(ORG, proposal.id).status, "superseded");
    assert.match((await adapter.read(URL, "browser", "raw")).html, /home baristas/);
  });

  void it("keeps tenant reads isolated and audit events append-only to callers", async () => {
    const { workflow, evidence, altChange } = createFixture();
    const proposal = await workflow.propose({
      organizationId: ORG,
      projectId: "p",
      findingId: "f",
      evidence,
      change: altChange,
    });
    assert.throws(
      () => workflow.get("another-org", proposal.id),
      (error: unknown) => error instanceof PatchWorkflowError && error.code === "TENANT_MISMATCH",
    );
    proposal.events.splice(0);
    assert.equal(workflow.get(ORG, proposal.id).events.length, 2);
  });

  void it("replays the same fixture write idempotently and rejects key reuse for changed content", async () => {
    const { adapter } = createFixture();
    const after = BASE_HTML.replace("Coffee brewing", "Ceramic dripper brewing guide");
    const expected = sha256(BASE_HTML);
    const first = await adapter.write(URL, after, expected, "fixture-idempotency-key");
    const replay = await adapter.write(URL, after, expected, "fixture-idempotency-key");
    assert.equal(first.idempotentReplay, false);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.contentHash, first.contentHash);
    await assert.rejects(
      Promise.resolve().then(() =>
        adapter.write(URL, BASE_HTML, expected, "fixture-idempotency-key"),
      ),
    );
  });
});
