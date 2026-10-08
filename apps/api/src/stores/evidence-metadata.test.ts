import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryStores } from "./memory.ts";
import type { StoredTemplateGroup } from "./types.ts";

void describe("memory-store evidence metadata privacy", () => {
  void it("filters historical group keys from evidence list and finding detail", async () => {
    const stores = createMemoryStores();
    const user = await stores.users.createUser("evidence@test.local", "hash");
    const organization = await stores.orgs.createOrganization(user.id, "Evidence", "evidence");
    const project = await stores.projects.createProject(
      organization.id,
      "Evidence project",
      "fixture.example",
    );
    const evidenceId = await stores.crawl.addEvidence(organization.id, project.id, {
      kind: "html_snapshot",
      sourceRef: "https://fixture.example/about",
      contentHash: "a".repeat(64),
      objectKey: "fixture/about",
      metadata: {
        pageUrl: "https://fixture.example/about",
        templateId: "deadbeef01234567",
        templateRoutePattern: "/users/jane-doe-:id",
        templateDomSignatureHash: "b".repeat(64),
        templateGroupingMethod: "URL_PATTERN_ONLY_FINGERPRINT_UNAVAILABLE_V1",
      },
    });
    const finding = await stores.crawl.addFinding(organization.id, project.id, {
      ruleId: "ONPAGE.MISSING_TITLE",
      ruleVersion: "1",
      title: "Missing title",
      epistemicClass: "OBSERVED",
      severity: "warning",
      affectedUrls: ["https://fixture.example/about"],
      verificationGate: "recrawl_rule_absent",
    });
    await stores.crawl.linkFindingEvidence(organization.id, finding.id, evidenceId.id);

    const listed = await stores.crawl.listEvidence(organization.id, project.id);
    const detail = await stores.crawl.getFinding(organization.id, finding.id);

    assert.deepEqual(listed[0]?.metadata, {
      pageUrl: "https://fixture.example/about",
    });
    assert.deepEqual(detail?.evidence[0]?.metadata, {
      pageUrl: "https://fixture.example/about",
    });
  });

  void it("does not return groups using the legacy raw-URL-only method", async () => {
    const stores = createMemoryStores();
    const user = await stores.users.createUser("history@test.local", "hash");
    const organization = await stores.orgs.createOrganization(user.id, "History", "history");
    const project = await stores.projects.createProject(
      organization.id,
      "History project",
      "fixture.example",
    );
    const run = await stores.crawl.createCrawlRun(organization.id, project.id, "site");
    assert.ok(run);
    const legacyGroup = {
      id: "b88b57f0e552634e",
      routePattern: "/articles/oversized",
      domSignatureHash: null,
      pageCount: 1,
      sampleUrls: ["https://fixture.example/articles/oversized"],
      groupingMethod: "URL_PATTERN_ONLY_FINGERPRINT_UNAVAILABLE_V1",
    } as unknown as StoredTemplateGroup;

    await stores.crawl.finishCrawlRun(organization.id, run.id, "completed", 1, 0, 1, undefined, [
      legacyGroup,
    ]);

    const history = await stores.crawl.listCrawlRuns(organization.id, project.id);
    assert.equal(history[0]?.templateGroups, null);
  });
});
