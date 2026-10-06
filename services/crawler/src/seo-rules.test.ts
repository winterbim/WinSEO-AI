import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHtmlPage } from "./html-parser.ts";
import { evaluatePageRules, RULES_VERSION } from "./seo-rules.ts";
import type { PageMeta } from "./seo-rules.ts";

/** A clean page that should produce NO on-page findings. */
const CLEAN_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Plomberie Genève — dépannage 24h/24 et devis gratuit</title>
  <meta name="description" content="Plombier à Genève : intervention en 1 heure, dépannage 24h/24 et devis gratuit pour toute fuite ou chauffe-eau.">
  <link rel="canonical" href="https://example.com/">
</head>
<body><h1>Plombier à Genève</h1><p>Contenu utile.</p></body>
</html>`;

const URL = "https://example.com/";

function meta(overrides: Partial<PageMeta> = {}): PageMeta {
  return {
    pageUrl: URL,
    finalUrl: URL,
    httpStatus: 200,
    contentHash: "a".repeat(64),
    redirectChain: [],
    contentLength: 1000,
    capturedAt: "2026-10-02T00:00:00Z",
    ...overrides,
  };
}

function rulesFor(html: string, m: Partial<PageMeta> = {}) {
  return evaluatePageRules(parseHtmlPage(html, m.finalUrl ?? URL), meta(m));
}

function ruleIds(html: string, m: Partial<PageMeta> = {}): string[] {
  return rulesFor(html, m).findings.map((f) => f.ruleId);
}

void describe("seo-rules (deterministic, no network)", () => {
  void it("a clean page produces no findings", () => {
    const r = rulesFor(CLEAN_HTML);
    assert.deepEqual(r.findings, []);
    // But evidence is always captured (the snapshot itself is the proof).
    assert.equal(r.evidence.length, 1);
    const [ev] = r.evidence;
    assert.ok(ev, "evidence entry must exist");
    assert.equal(ev.kind, "html_snapshot");
  });

  void it("is deterministic: identical input yields identical output", () => {
    const a = rulesFor(CLEAN_HTML.replace("Plombier à Genève", "Chauffagiste à Lyon"));
    const b = rulesFor(CLEAN_HTML.replace("Plombier à Genève", "Chauffagiste à Lyon"));
    assert.deepEqual(a, b);
  });

  void it("every finding is epistemically OBSERVED and carries a ruleVersion", () => {
    const r = rulesFor("<html><body></body></html>");
    assert.ok(r.findings.length > 0);
    for (const f of r.findings) {
      assert.equal(f.epistemicClass, "OBSERVED");
      assert.equal(f.ruleVersion, RULES_VERSION);
      assert.ok(f.ruleId.includes("."), `${f.ruleId} should be namespaced`);
      assert.ok(f.explanation.length > 10, `${f.ruleId} needs a real explanation`);
      assert.deepEqual(f.affectedUrls, [URL]);
    }
  });

  void it("no finding claims engine behaviour (no penalty/ranking assertions)", () => {
    const r = rulesFor("<html><body></body></html>");
    const banned = /google (vous )?p[ée]nalise|will rank|ranking factor|guarantee|penali[sz]ed you/i;
    for (const f of r.findings) {
      const text = `${f.title} ${f.explanation}`;
      assert.ok(!banned.test(text), `${f.ruleId} asserts engine behaviour: ${text}`);
    }
  });

  void it("flags a missing title / description / H1", () => {
    const ids = ruleIds("<html><head></head><body><p>x</p></body></html>");
    assert.ok(ids.includes("ONPAGE.MISSING_TITLE"));
    assert.ok(ids.includes("ONPAGE.MISSING_META_DESCRIPTION"));
    assert.ok(ids.includes("ONPAGE.MISSING_H1"));
  });

  void it("flags title too short and too long, but only one rule fires per title", () => {
    const short = ruleIds(
      `<html><head><title>Hi</title><meta name="description" content="${"d".repeat(140)}"></head><body><h1>H</h1></body></html>`,
    );
    assert.ok(short.includes("ONPAGE.TITLE_TOO_SHORT"));
    assert.ok(!short.includes("ONPAGE.TITLE_TOO_LONG"));

    const long = ruleIds(
      `<html><head><title>${"T".repeat(95)}</title><meta name="description" content="${"d".repeat(140)}"></head><body><h1>H</h1></body></html>`,
    );
    assert.ok(long.includes("ONPAGE.TITLE_TOO_LONG"));
    assert.ok(!long.includes("ONPAGE.TITLE_TOO_SHORT"));
  });

  void it("flags an over-long meta description", () => {
    const ids = ruleIds(
      `<html lang="fr"><head><meta name="viewport" content="width=device-width"><title>${"T".repeat(45)}</title><meta name="description" content="${"d".repeat(200)}"></head><body><h1>H</h1><link rel="canonical" href="${URL}"></body></html>`,
    );
    assert.ok(ids.includes("ONPAGE.META_DESC_TOO_LONG"));
  });

  void it("flags multiple H1s", () => {
    const ids = ruleIds(
      `<html lang="fr"><head><meta name="viewport" content="width=device-width"><title>${"T".repeat(45)}</title><meta name="description" content="${"d".repeat(140)}"></head><body><h1>A</h1><h1>B</h1><link rel="canonical" href="${URL}"></body></html>`,
    );
    assert.ok(ids.includes("ONPAGE.MULTIPLE_H1"));
  });

  void it("flags missing canonical", () => {
    const ids = ruleIds(
      `<html lang="fr"><head><meta name="viewport" content="width=device-width"><title>${"T".repeat(45)}</title><meta name="description" content="${"d".repeat(140)}"></head><body><h1>H</h1></body></html>`,
    );
    assert.ok(ids.includes("TECH.MISSING_CANONICAL"));
  });

  void it("flags a canonical pointing elsewhere, worded as observation not penalty", () => {
    const html = CLEAN_HTML.replace(
      '<link rel="canonical" href="https://example.com/">',
      '<link rel="canonical" href="https://other.example/page">',
    );
    const r = rulesFor(html);
    const f = r.findings.find((x) => x.ruleId === "TECH.CANONICAL_NOT_SELF_REFERENCING");
    assert.ok(f, "canonical mismatch rule must fire");
    assert.ok(f.explanation.includes("may be intentional"));
    assert.ok(!/penali|will rank/i.test(f.explanation));
  });

  void it("a self-referencing canonical produces no canonical finding", () => {
    // parseHtmlPage resolves the href against the fetched URL, so this matches.
    const ids = ruleIds(CLEAN_HTML);
    assert.ok(!ids.includes("TECH.MISSING_CANONICAL"));
    assert.ok(!ids.includes("TECH.CANONICAL_NOT_SELF_REFERENCING"));
  });

  void it("flags noindex in robots meta", () => {
    const ids = ruleIds(
      `<html lang="fr"><head><meta name="viewport" content="width=device-width"><title>${"T".repeat(45)}</title><meta name="description" content="${"d".repeat(140)}"><meta name="robots" content="noindex, nofollow"><link rel="canonical" href="${URL}"></head><body><h1>H</h1></body></html>`,
    );
    assert.ok(ids.includes("CRAWL.ROBOTS_NOINDEX"));
  });

  void it("flags invalid JSON-LD but accepts valid JSON-LD", () => {
    const bad = ruleIds(CLEAN_HTML.replace(
      "</head>",
      `<script type="application/ld+json">{not json</script></head>`,
    ));
    assert.ok(bad.includes("STRUCTURED_DATA.INVALID_JSON"));

    const good = ruleIds(CLEAN_HTML.replace(
      "</head>",
      `<script type="application/ld+json">{"@type":"Organization"}</script></head>`,
    ));
    assert.ok(!good.includes("STRUCTURED_DATA.INVALID_JSON"));
  });

  void it("flags missing html lang and missing viewport", () => {
    const ids = ruleIds(
      `<html><head><title>${"T".repeat(45)}</title><meta name="description" content="${"d".repeat(140)}"><link rel="canonical" href="${URL}"></head><body><h1>H</h1></body></html>`,
    );
    assert.ok(ids.includes("ONPAGE.MISSING_HTML_LANG"));
    assert.ok(ids.includes("ONPAGE.MISSING_VIEWPORT"));
  });

  void it("records a redirect chain as an observation with the real hop path", () => {
    const r = evaluatePageRules(parseHtmlPage(CLEAN_HTML, URL), {
      ...meta(),
      finalUrl: URL,
      redirectChain: ["http://example.com", "https://example.com"],
    });
    const f = r.findings.find((x) => x.ruleId === "CRAWL.REDIRECT_CHAIN");
    assert.ok(f, "redirect chain rule must fire when hops exist");
    assert.equal(f.severity, "info", "two hops is informational, not a problem");
    assert.ok(f.explanation.includes("http://example.com → https://example.com"));
  });

  void it("escalates redirect severity past two hops", () => {
    const r = evaluatePageRules(parseHtmlPage(CLEAN_HTML, URL), {
      ...meta(),
      redirectChain: ["http://a", "http://b", "http://c"],
    });
    const f = r.findings.find((x) => x.ruleId === "CRAWL.REDIRECT_CHAIN");
    assert.ok(f, "redirect-chain finding must be present");
    assert.equal(f.severity, "medium");
  });

  void it("no redirect chain => no redirect finding", () => {
    const ids = ruleIds(CLEAN_HTML);
    assert.ok(!ids.includes("CRAWL.REDIRECT_CHAIN"));
  });

  void it("evidence carries the content hash and final url (reproducibility)", () => {
    const hash = "b".repeat(64);
    const r = evaluatePageRules(parseHtmlPage(CLEAN_HTML, URL), { ...meta(), contentHash: hash });
    const [ev] = r.evidence;
    assert.ok(ev, "evidence entry must exist");
    assert.equal(ev.contentHash, hash);
    assert.equal(ev.finalUrl, URL);
    assert.equal(ev.httpStatus, 200);
    assert.ok(ev.summary.includes(hash.slice(0, 16)), "summary should expose a hash prefix");
    assert.ok(ev.summary.includes('title="Plomberie'), "summary should record what was observed");
  });

  void it("severity values stay within the contract vocabulary", () => {
    const allowed = new Set(["critical", "high", "medium", "low", "info"]);
    const r = rulesFor("<html><body></body></html>");
    for (const f of r.findings) assert.ok(allowed.has(f.severity), `${f.ruleId}: ${f.severity}`);
  });
});
