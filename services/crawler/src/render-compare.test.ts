import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareSourceRender, describeDivergences } from "./render-compare.ts";
import { parseHtmlPage } from "./html-parser.ts";

const URL_ = "https://example.com/page";

void describe("source-vs-render comparison", () => {
  void it("reports no divergence for identical documents", () => {
    const html = `<!DOCTYPE html><html lang="en"><head>
      <title>Same</title><meta name="description" content="d">
      <link rel="canonical" href="${URL_}">
    </head><body><h1>H</h1><p>${"text ".repeat(80)}</p></body></html>`;
    const source = parseHtmlPage(html, URL_);
    const result = compareSourceRender(source, html, URL_);
    assert.equal(result.divergences.length, 0, describeDivergences(result.divergences));
  });

  void it("detects a JS-injected canonical", () => {
    const sourceHtml = `<!DOCTYPE html><html><head><title>T</title></head>
      <body><p>${"text ".repeat(80)}</p></body></html>`;
    const renderedHtml = `<!DOCTYPE html><html><head><title>T</title>
      <link rel="canonical" href="${URL_}"></head>
      <body><p>${"text ".repeat(80)}</p></body></html>`;
    const source = parseHtmlPage(sourceHtml, URL_);
    const result = compareSourceRender(source, renderedHtml, URL_);
    const canon = result.divergences.find((d) => d.field === "canonical");
    assert.ok(canon, "canonical divergence must be reported");
    assert.equal(canon.source, "(absent)");
    assert.equal(canon.rendered, URL_);
  });

  void it("detects a runtime title change", () => {
    const sourceHtml = `<html><head><title>Static Title</title></head><body><p>${"x ".repeat(80)}</p></body></html>`;
    const renderedHtml = `<html><head><title>Client Rendered Title</title></head><body><p>${"x ".repeat(80)}</p></body></html>`;
    const source = parseHtmlPage(sourceHtml, URL_);
    const result = compareSourceRender(source, renderedHtml, URL_);
    const title = result.divergences.find((d) => d.field === "title");
    assert.ok(title);
    assert.equal(title.source, "Static Title");
    assert.equal(title.rendered, "Client Rendered Title");
  });

  void it("detects H1 sets that only exist after render", () => {
    const sourceHtml = `<html><head><title>T</title></head><body><p>${"y ".repeat(80)}</p></body></html>`;
    const renderedHtml = `<html><head><title>T</title></head><body><h1>Injected</h1><p>${"y ".repeat(80)}</p></body></html>`;
    const source = parseHtmlPage(sourceHtml, URL_);
    const result = compareSourceRender(source, renderedHtml, URL_);
    const h1 = result.divergences.find((d) => d.field === "H1 headings");
    assert.ok(h1);
    assert.equal(h1.rendered, "Injected");
  });

  void it("describeDivergences produces a human summary", () => {
    const sourceHtml = `<html><head></head><body><p>${"z ".repeat(80)}</p></body></html>`;
    const renderedHtml = `<html><head><title>N</title></head><body><p>${"z ".repeat(80)}</p></body></html>`;
    const source = parseHtmlPage(sourceHtml, URL_);
    const result = compareSourceRender(source, renderedHtml, URL_);
    const text = describeDivergences(result.divergences);
    assert.match(text, /title:/);
    assert.match(text, /rendered="N"/);
  });
});
