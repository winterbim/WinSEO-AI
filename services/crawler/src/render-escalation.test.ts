import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldRender } from "./render-escalation.ts";
import { parseHtmlPage } from "./html-parser.ts";

const URL_ = "https://example.com/";

function healthyPage(): string {
  // A normal, content-complete static page: must NOT trigger escalation.
  const paragraph =
    "This page contains a substantial amount of server-rendered content that explains " +
    "the product, its methodology, the pricing tiers, security posture and integration " +
    "details, so a crawler reading the raw HTML sees everything a reader would see " +
    "without executing a single line of JavaScript in the browser.";
  return `<!DOCTYPE html><html lang="en"><head>
    <title>Fully Rendered Page</title>
    <meta name="description" content="A complete static page used as control fixture.">
    <link rel="canonical" href="https://example.com/">
  </head><body><h1>Heading</h1><p>${paragraph}</p></body></html>`;
}

function shellPage(): string {
  return `<!DOCTYPE html><html lang="en"><head><title></title></head>
    <body><div id="root"></div>
    <noscript>You need to enable JavaScript to run this app.</noscript>
    </body></html>`;
}

void describe("render escalation decision", () => {
  void it("does NOT escalate a content-complete static page", () => {
    const html = healthyPage();
    const decision = shouldRender(parseHtmlPage(html, URL_), html);
    assert.equal(decision.escalate, false, `unexpected reasons: ${decision.reasons.join(" | ")}`);
    assert.equal(decision.reasons.length, 0);
  });

  void it("escalates a thin SPA shell with SHELL_ONLY_BODY", () => {
    const html = shellPage();
    const decision = shouldRender(parseHtmlPage(html, URL_), html);
    assert.ok(decision.escalate);
    assert.ok(
      decision.reasons.some((r) => r.startsWith("SHELL_ONLY_BODY")),
      decision.reasons.join(" | "),
    );
  });

  void it("escalates an empty framework mount with APP_MOUNT_EMPTY", () => {
    const html = shellPage();
    const decision = shouldRender(parseHtmlPage(html, URL_), html);
    assert.ok(decision.reasons.some((r) => r.startsWith("APP_MOUNT_EMPTY")));
  });

  void it("escalates when content is gated behind JavaScript (NOSCRIPT_CONTENT)", () => {
    const html = shellPage();
    const decision = shouldRender(parseHtmlPage(html, URL_), html);
    assert.ok(decision.reasons.some((r) => r.startsWith("NOSCRIPT_CONTENT")));
  });

  void it("escalates when source has neither title nor meta description", () => {
    const html = `<html><body><p>${"word ".repeat(80)}</p></body></html>`;
    const decision = shouldRender(parseHtmlPage(html, URL_), html);
    assert.ok(decision.reasons.some((r) => r.startsWith("HEAD_UNPOPULATED")));
  });

  void it("every escalation carries explicit human-readable reasons", () => {
    const html = shellPage();
    const decision = shouldRender(parseHtmlPage(html, URL_), html);
    assert.ok(decision.reasons.length > 0);
    for (const r of decision.reasons) {
      assert.ok(r.includes(":"), `reason must be prefixed and explicit: ${r}`);
      assert.ok(r.length > 20, `reason must explain itself: ${r}`);
    }
  });
});
