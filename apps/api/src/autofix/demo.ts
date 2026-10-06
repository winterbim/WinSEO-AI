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

const organizationId = "org-local-demo";
const projectId = "project-local-demo";
const actor: PatchActor = {
  organizationId,
  userId: "reviewer-local-demo",
  email: "reviewer@fixture.test",
};
let tick = Date.now() - 60_000;
const clock = () => new Date((tick += 10));
const { page, wordpress, simulator } = createWordPressFixture(clock);
const workflow = new ProvenPatchWorkflow(page, clock);

const initial = await page.read(WORDPRESS_FIXTURE_URL, "browser", "raw");
const initialHash = sha256(initial.html);

function evidence(html: string, visualReview?: PatchEvidence["visualReview"]): PatchEvidence {
  return {
    url: WORDPRESS_FIXTURE_URL,
    capturedAt: clock().toISOString(),
    rawHtml: html,
    contentHash: sha256(html),
    visibleText: "Ceramic dripper brewing guide for home kitchens.",
    ...(visualReview ? { visualReview } : {}),
  };
}

const altProposal = await workflow.propose({
  organizationId,
  projectId,
  findingId: "finding-image-alt",
  evidence: evidence(initial.html, {
    role: "informative",
    description: "Ceramic dripper",
  }),
  change: {
    field: "image_alt",
    before: "",
    after: "Ceramic dripper",
    imageId: "hero",
    imageRole: "informative",
  },
});
const altPreview = await workflow.preview(organizationId, altProposal.id);
workflow.approve(organizationId, altProposal.id, actor, altPreview.contentHash);
const altDeployment = await workflow.deploy(
  organizationId,
  altProposal.id,
  actor,
  fixtureStepUpProof(actor.userId, new Date(Date.now() - 2_000).toISOString()),
);
const altLive = await workflow.verify(organizationId, altProposal.id);
if (altLive.status !== "live_verified") {
  throw new Error(`Expected image alt to reach live_verified, got ${altLive.status}`);
}
const altRollback = await workflow.rollback(organizationId, altProposal.id);
if (altRollback.status !== "rolled_back") throw new Error("Image alt rollback was not verified.");

const titleBefore = await page.read(WORDPRESS_FIXTURE_URL, "browser", "raw");
const titleProposal = await workflow.propose({
  organizationId,
  projectId,
  findingId: "finding-page-title",
  evidence: evidence(titleBefore.html),
  change: {
    field: "title",
    before: "Coffee brewing",
    after: "Ceramic dripper brewing guide",
  },
});
const titlePreview = await workflow.preview(organizationId, titleProposal.id);
workflow.approve(organizationId, titleProposal.id, actor, titlePreview.contentHash);
const manualTitle = await workflow.deployManually(
  organizationId,
  titleProposal.id,
  actor,
  fixtureStepUpProof(actor.userId, new Date(Date.now() - 2_000).toISOString()),
);
const titleSource = await wordpress.read(WORDPRESS_FIXTURE_TITLE_TARGET);
await wordpress.apply(WORDPRESS_FIXTURE_TITLE_TARGET, titleSource.hash, titleProposal.change.after);
const titleLive = await workflow.verify(organizationId, titleProposal.id);
if (titleLive.status !== "live_verified") {
  throw new Error(`Expected manual title to reach live_verified, got ${titleLive.status}`);
}
const titleRollback = await workflow.rollback(organizationId, titleProposal.id);
if (titleRollback.status !== "rolled_back") throw new Error("Title rollback was not verified.");

const final = await page.read(WORDPRESS_FIXTURE_URL, "googlebot", "rendered");
const finalHash = sha256(final.html);
if (finalHash !== initialHash)
  throw new Error("Rollback did not restore the original SEO HTML hash.");

process.stdout.write(
  `${JSON.stringify(
    {
      mode: "fixture-only",
      cms: "in-process WordPress REST contract simulator",
      wordpressApiValidation: "not validated against the real WordPress API",
      networkRequests: 0,
      patches: [
        {
          field: "image_alt",
          risk: altProposal.risk,
          preview: altPreview.mode,
          deployed: altDeployment.status,
          verified: altLive.status,
          rolledBack: altRollback.status,
        },
        {
          field: "title",
          risk: titleProposal.risk,
          preview: titlePreview.mode,
          deployed: manualTitle.status,
          verified: titleLive.status,
          rolledBack: titleRollback.status,
        },
      ],
      restMethods: [...new Set(simulator.requests.map((request) => request.method))],
      initialHash,
      finalHash,
      restored: initialHash === finalHash,
    },
    null,
    2,
  )}\n`,
);
