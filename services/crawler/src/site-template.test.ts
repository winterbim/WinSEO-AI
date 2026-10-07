import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  groupSitePagesByTemplate,
  isPrivacySafeTemplateGroupMetadata,
  semanticDomSignature,
} from "./site-template.ts";

void describe("observed site structure grouping", () => {
  void it("groups explicit numeric suffix IDs only when the semantic DOM signature matches", () => {
    const pages = [
      {
        url: "https://fixture.example/articles/story-001?visitor=email%40example.test#section",
        html: "<main><article><h1>First</h1><p>Text A</p></article></main>",
      },
      {
        url: "https://fixture.example/articles/story-002",
        html: "<main><article><h1>Second</h1><p>Text B</p></article></main>",
      },
      {
        url: "https://fixture.example/articles/story-003",
        html: "<main><article><h1>Third</h1><p>Text C</p></article></main>",
      },
      {
        url: "https://fixture.example/articles/story-004",
        html: "<main><section><h1>Different structure</h1><ul><li>One</li></ul></section></main>",
      },
    ];

    const result = groupSitePagesByTemplate(pages);
    const firstPage = pages.at(0);
    const differentPage = pages.at(3);
    assert.equal(result.groups.length, 2);
    assert.ok(firstPage && differentPage);
    const articleGroup = result.byUrl.get(firstPage.url);
    assert.ok(articleGroup);
    assert.equal(articleGroup.routePattern, "/articles/story-:id");
    assert.equal(articleGroup.pageCount, 3);
    assert.equal(articleGroup.sampleUrls.length, 1);
    assert.ok(articleGroup.sampleUrls.every((url) => !url.includes("?") && !url.includes("#")));
    assert.notEqual(semanticDomSignature(firstPage.html), semanticDomSignature(differentPage.html));
  });

  void it("does not retain text, classes, or attributes in the structure hash", () => {
    const first =
      '<main class="one"><article><h1 id="a">First title</h1><p>One</p></article></main>';
    const second =
      '<main class="two"><article><h1 id="b">Another title</h1><p>Two</p></article></main>';

    assert.equal(semanticDomSignature(first), semanticDomSignature(second));
  });

  void it("ignores comments and raw-text contents while retaining the containing element", () => {
    const cases = [
      [
        "<main><!-- <article><h1>comment</h1> --><p>Text</p></main>",
        "<main><!-- <table> --><p>Other</p></main>",
      ],
      [
        "<main><script>const x = '<article><h1>';</script><p>Text</p></main>",
        "<main><script>document.write('<table>');</script><p>Other</p></main>",
      ],
      [
        "<main><style>.x::after { content: '<article>'; }</style><p>Text</p></main>",
        "<main><style>.x { content: '<table>'; }</style><p>Other</p></main>",
      ],
      [
        "<main><textarea><article><h1>value</h1></textarea><p>Text</p></main>",
        "<main><textarea><table></textarea><p>Other</p></main>",
      ],
      [
        "<main><iframe><article><h1>fallback</h1></iframe><p>Text</p></main>",
        "<main><iframe><table>other fallback</iframe><p>Other</p></main>",
      ],
    ];

    for (const [first, second] of cases) {
      assert.ok(first && second);
      assert.equal(semanticDomSignature(first), semanticDomSignature(second));
    }
    assert.notEqual(
      semanticDomSignature("<main><iframe></iframe></main>"),
      semanticDomSignature("<main></main>"),
    );
  });

  void it("uses browser HTML5 parsing for comment endings, SVG CDATA, implicit closes, and slash syntax", () => {
    assert.equal(
      semanticDomSignature("<main><!-- fake --!><p>Text</p></main>"),
      semanticDomSignature("<main><p>Other</p></main>"),
    );
    assert.equal(
      semanticDomSignature(
        "<main><svg><![CDATA[<article><h1>not DOM</h1>]]></svg><p>Text</p></main>",
      ),
      semanticDomSignature("<main><svg></svg><p>Other</p></main>"),
    );
    assert.equal(
      semanticDomSignature("<main><ul><li>One<li>Two</ul></main>"),
      semanticDomSignature("<main><ul><li>One</li><li>Two</li></ul></main>"),
    );
    assert.equal(
      semanticDomSignature("<main/><p>One</p>"),
      semanticDomSignature("<main><p>Two</p></main>"),
    );
  });

  void it("preserves nested structural shape instead of collapsing repeated tag names", () => {
    assert.notEqual(
      semanticDomSignature("<main><section><section><h2>Nested</h2></section></section></main>"),
      semanticDomSignature("<main><section><h2>Flat</h2></section></main>"),
    );
    assert.notEqual(
      semanticDomSignature("<main><section><p>One</p></section></main>"),
      semanticDomSignature(
        "<main><section><p>One</p></section><section><p>Two</p></section></main>",
      ),
    );
  });

  void it("does not infer dynamic slugs from ordinary static sibling routes", () => {
    const pages = ["new", "archive", "search", "api-intro", "api-reference", "api-search"].map(
      (path) => ({
        url: `https://fixture.example/docs/${path}`,
        html: "<main><article><h1>Documentation</h1></article></main>",
      }),
    );
    const result = groupSitePagesByTemplate(pages);
    assert.equal(result.groups.length, 6);
    assert.equal(
      result.groups.filter((group) => group.routePattern === "/docs/:private").length,
      5,
    );
    assert.equal(result.groups.filter((group) => group.routePattern === "/docs/search").length, 1);
    assert.ok(result.groups.every((group) => group.pageCount === 1));
    assert.equal(new Set(result.groups.map((group) => group.id)).size, 6);
  });

  void it("deduplicates displayed sample URLs after removing query strings", () => {
    const pages = ["001", "002", "003"].map((id, index) => ({
      url: `https://fixture.example/articles/story-${id}?variant=${index}`,
      html: "<main><article><h1>Story</h1></article></main>",
    }));
    const result = groupSitePagesByTemplate(pages);
    assert.equal(result.groups.length, 1);
    const group = result.groups[0];
    assert.ok(group);
    assert.equal(group.pageCount, 3);
    assert.deepEqual(group.sampleUrls, ["https://fixture.example/articles/story-:id"]);
  });

  void it("redacts emails, numeric IDs, UUIDs, and sensitive path tails", () => {
    const result = groupSitePagesByTemplate([
      {
        url: "https://fixture.example/reset/alice%40example.com?token=query-secret",
        html: "<main><h1>Reset</h1></main>",
      },
      {
        url: "https://fixture.example/orders/123456789",
        html: "<main><h1>Order</h1></main>",
      },
      {
        url: "https://fixture.example/users/00000000-0000-0000-0000-000000000000",
        html: "<main><h1>User</h1></main>",
      },
      {
        url: "https://fixture.example/invite/accept/AB12CD",
        html: "<main><h1>Invite</h1></main>",
      },
      {
        url: "https://fixture.example/share/AB12CD",
        html: "<main><h1>Share</h1></main>",
      },
    ]);
    const samples = result.groups.flatMap((group) => group.sampleUrls);
    assert.ok(samples.includes("https://fixture.example/reset/:private"));
    assert.ok(samples.includes("https://fixture.example/orders/:id"));
    assert.ok(samples.includes("https://fixture.example/users/:id"));
    assert.ok(samples.includes("https://fixture.example/invite/:private/:private"));
    assert.ok(samples.includes("https://fixture.example/share/:private"));
    assert.ok(
      samples.every((sample) => !/alice|query-secret|123456789|AB12CD|00000000/.test(sample)),
    );
    assert.ok(result.groups.every((group) => !group.routePattern.includes("AB12CD")));
    assert.ok(result.groups.some((group) => group.routePattern === "/invite/:private/:private"));
  });

  void it("never publishes unknown path values to route patterns or sample URLs", () => {
    const result = groupSitePagesByTemplate([
      {
        url: "https://fixture.example/users/jane-doe-123",
        html: "<main><h1>User</h1></main>",
      },
      {
        url: "https://fixture.example/contact/+1-415-555-1234",
        html: "<main><h1>Contact</h1></main>",
      },
      {
        url: "https://fixture.example/t/AB12CD",
        html: "<main><h1>Short token</h1></main>",
      },
    ]);
    const routeAndSampleValues = result.groups.flatMap((group) => [
      group.routePattern,
      ...group.sampleUrls,
    ]);
    assert.deepEqual(
      result.groups.map((group) => group.routePattern).sort(),
      ["/contact/:private", "/users/:private", "/:private/:private"].sort(),
    );
    assert.ok(routeAndSampleValues.every((value) => !/jane-doe|415|555|1234|AB12CD/.test(value)));
    assert.equal(isPrivacySafeTemplateGroupMetadata("/users/jane-doe-:id", []), false);
    assert.equal(
      isPrivacySafeTemplateGroupMetadata("/:private/:private", [
        "https://fixture.example/t/AB12CD",
      ]),
      false,
    );
    assert.equal(
      isPrivacySafeTemplateGroupMetadata(
        "/articles/story-:id",
        ["https://fixture.example/articles/story-:id"],
        "URL_PATTERN_AND_SEMANTIC_DOM_V2",
        3,
      ),
      true,
    );
    assert.equal(
      isPrivacySafeTemplateGroupMetadata("/guide/:id", ["https://fixture.example/guide/:id"]),
      false,
    );
  });

  void it("keeps two numeric-looking static siblings separate and generalizes only three proven IDs", () => {
    const staticPair = groupSitePagesByTemplate(
      ["step-1", "step-2"].map((leaf) => ({
        url: `https://fixture.example/guide/${leaf}`,
        html: "<main><article><h1>Guide</h1></article></main>",
      })),
    );
    assert.equal(staticPair.groups.length, 2);
    assert.ok(staticPair.groups.every((group) => group.pageCount === 1));
    assert.ok(
      staticPair.groups.every(
        (group) => group.groupingMethod === "SEMANTIC_DOM_PRIVACY_SINGLETON_V1",
      ),
    );
    assert.ok(staticPair.groups.every((group) => group.routePattern === "/guide/:private"));

    const provenSiblings = groupSitePagesByTemplate(
      ["1", "2", "3"].map((id) => ({
        url: `https://fixture.example/articles/${id}`,
        html: "<main><article><h1>Article</h1></article></main>",
      })),
    );
    assert.equal(provenSiblings.groups.length, 1);
    const provenGroup = provenSiblings.groups[0];
    assert.ok(provenGroup);
    assert.equal(provenGroup.pageCount, 3);
    assert.equal(provenGroup.routePattern, "/articles/:id");
  });

  void it("leaves pages over the parse budget as separate URL-only groups", () => {
    const result = groupSitePagesByTemplate([
      {
        url: "https://fixture.example/articles/large-a",
        html: `<main>${"<p>".repeat(40_000)}</main>`,
      },
      {
        url: "https://fixture.example/articles/large-b",
        html: `<main>${"<p>".repeat(40_000)}</main>`,
      },
    ]);
    assert.equal(semanticDomSignature("x".repeat(128 * 1024 + 1)), null);
    assert.equal(result.groups.length, 2);
    assert.ok(result.groups.every((group) => group.domSignatureHash === null));
    assert.ok(
      result.groups.every(
        (group) => group.groupingMethod === "URL_PATTERN_ONLY_PRIVACY_SINGLETON_V2",
      ),
    );
    assert.ok(result.groups.every((group) => group.pageCount === 1));
  });

  void it("keeps numeric order paths as valid redacted singletons", () => {
    const result = groupSitePagesByTemplate([
      {
        url: "https://fixture.example/orders/123",
        html: "<main><article><h1>Order detail</h1></article></main>",
      },
    ]);

    assert.equal(result.groups.length, 1);
    const group = result.groups[0];
    assert.ok(group);
    assert.equal(group.routePattern, "/orders/:id");
    assert.equal(group.pageCount, 1);
    assert.equal(group.groupingMethod, "SEMANTIC_DOM_PRIVACY_SINGLETON_V1");
    assert.deepEqual(group.sampleUrls, ["https://fixture.example/orders/:id"]);
  });

  void it("does not derive URL-only group IDs from query secrets", () => {
    const pages = ["alpha-secret", "beta-secret"].map((token) => ({
      url: `https://fixture.example/articles/oversized?token=${token}`,
      html: `<main>${"<p>".repeat(40_000)}</main>`,
    }));
    const result = groupSitePagesByTemplate(pages);
    const groupIds = result.groups.map((group) => group.id);
    assert.equal(result.groups.length, 2);
    assert.equal(new Set(groupIds).size, 2);
    assert.deepEqual(
      result.groups.map((group) => group.sampleUrls[0]),
      ["https://fixture.example/articles/:private", "https://fixture.example/articles/:private"],
    );
    for (const [index, page] of pages.entries()) {
      const priorRawUrlHash = createHash("sha256")
        .update(`budgeted\n${page.url}`)
        .digest("hex")
        .slice(0, 16);
      assert.notEqual(groupIds[index], priorRawUrlHash);
    }
    assert.ok(groupIds.every((id) => !/alpha-secret|beta-secret/.test(id)));
  });

  void it("includes semantic elements in template.content in the shape fingerprint", () => {
    assert.notEqual(
      semanticDomSignature("<main><template><article><h1>Inside</h1></article></template></main>"),
      semanticDomSignature("<main><template></template></main>"),
    );
  });

  void it("keeps static-looking text routes separate even under an article collection", () => {
    const pages = ["api-intro", "api-reference", "api-search"].map((path) => ({
      url: `https://fixture.example/articles/${path}`,
      html: "<main><article><h1>Documentation</h1></article></main>",
    }));
    const result = groupSitePagesByTemplate(pages);
    assert.equal(result.groups.length, 3);
    assert.ok(result.groups.every((group) => group.routePattern === "/articles/:private"));
    assert.ok(result.groups.every((group) => group.pageCount === 1));
  });

  void it("keeps two versus three repeated children in the documented cardinality bucket", () => {
    assert.equal(
      semanticDomSignature("<main><section></section><section></section></main>"),
      semanticDomSignature(
        "<main><section></section><section></section><section></section></main>",
      ),
    );
  });
});
