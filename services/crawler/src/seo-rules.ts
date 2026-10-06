// ─── Deterministic SEO rule engine ───
// Blueprint §13: checks that can be computed correctly by code stay deterministic.
// No LLM, no estimated third-party metrics, no aggregate "SEO score", and no rule
// claims knowledge of how any search engine actually ranks pages.
//
// Extraction of document structure is delegated to parseHtmlPage() so HTML parsing
// and rule logic each exist exactly once. This module is pure (no I/O), which lets
// every rule be unit-tested without network access — including against hosts that
// the SSRF guard must refuse to scan.

import type { ParsedPage } from "./html-parser.ts";

export interface PageMeta {
  /** The URL the user asked about (may differ from finalUrl after redirects). */
  pageUrl: string;
  /** The URL actually fetched after redirects. */
  finalUrl: string;
  httpStatus: number;
  /** SHA-256 of the fetched body; lets a re-crawl prove whether it changed. */
  contentHash: string;
  /** Every intermediate redirect target, in order. */
  redirectChain: string[];
  contentLength: number;
  capturedAt: string;
}

export interface EvidenceRecord {
  kind: string;
  sourceRef: string;
  finalUrl: string;
  capturedAt: string;
  httpStatus: number;
  contentHash: string;
  contentLength: number;
  redirectChain: string[];
  summary: string;
  /** Producer-supplied extra fields persisted with the evidence row
   *  (e.g. escalation reasons, source-vs-render divergences, DOM excerpt). */
  metadata?: Record<string, unknown>;
}

export interface RuleFinding {
  ruleId: string;
  title: string;
  /** NEXUS doctrine: OBSERVED for everything produced here — these are direct document facts. */
  epistemicClass: "OBSERVED";
  severity: "critical" | "high" | "medium" | "low" | "info";
  explanation: string;
  affectedUrls: string[];
  recommendation?: string;
  /** Rule version, so a finding can be reproduced against the same engine. */
  ruleVersion: string;
}

export interface RuleResult {
  findings: RuleFinding[];
  evidence: EvidenceRecord[];
}

/** Version of this rule set. Bump when a rule's behaviour changes. */
export const RULES_VERSION = "1.1.0";

/**
 * Verification gate declared by each rule's contract (Blueprint §13.2).
 * Stored on the finding at insert time so a finding stays reproducible even if
 * this catalog changes later.
 *
 * - `recrawl_rule_absent` — after the recommended fix, a re-crawl must show the
 *   rule no longer fires. This is the honest gate for every deterministic
 *   page/crawl defect in this engine: it verifies the OBSERVED fact changed,
 *   never an engine-behaviour claim.
 * - `none` — policy rejections (SSRF/URL rejected): there is no page defect to
 *   re-measure; the gate would only re-check that the policy still applies.
 */
export const RULE_VERIFICATION_GATES: Record<string, string> = {
  "ONPAGE.MISSING_TITLE": "recrawl_rule_absent",
  "ONPAGE.TITLE_TOO_SHORT": "recrawl_rule_absent",
  "ONPAGE.TITLE_TOO_LONG": "recrawl_rule_absent",
  "ONPAGE.MISSING_META_DESCRIPTION": "recrawl_rule_absent",
  "ONPAGE.META_DESC_TOO_LONG": "recrawl_rule_absent",
  "ONPAGE.MISSING_H1": "recrawl_rule_absent",
  "ONPAGE.MULTIPLE_H1": "recrawl_rule_absent",
  "ONPAGE.MISSING_HTML_LANG": "recrawl_rule_absent",
  "ONPAGE.MISSING_VIEWPORT": "recrawl_rule_absent",
  "TECH.MISSING_CANONICAL": "recrawl_rule_absent",
  "TECH.CANONICAL_NOT_SELF_REFERENCING": "recrawl_rule_absent",
  "CRAWL.ROBOTS_NOINDEX": "recrawl_rule_absent",
  "CRAWL.REDIRECT_CHAIN": "recrawl_rule_absent",
  "CRAWL.NON_HTML": "recrawl_rule_absent",
  "CRAWL.HTTP_ERROR": "recrawl_rule_absent",
  "STRUCTURED_DATA.INVALID_JSON": "recrawl_rule_absent",
  "CRAWL.SSRF_BLOCKED": "none",
  "CRAWL.URL_REJECTED": "none",
  "JS.SOURCE_RENDER_DIVERGENCE": "recrawl_rule_absent",
};

/** Declared gate for a rule id; defaults to re-crawl verification. */
export function gateForRule(ruleId: string): string {
  return RULE_VERIFICATION_GATES[ruleId] ?? "recrawl_rule_absent";
}

function observed(
  ruleId: string,
  title: string,
  severity: RuleFinding["severity"],
  explanation: string,
  url: string,
  recommendation?: string,
): RuleFinding {
  return {
    ruleId,
    title,
    epistemicClass: "OBSERVED",
    severity,
    explanation,
    affectedUrls: [url],
    recommendation,
    ruleVersion: RULES_VERSION,
  };
}

/**
 * Run every deterministic page rule against one fetched document.
 * Pure function: same input always yields the same findings.
 */
export function evaluatePageRules(page: ParsedPage, meta: PageMeta): RuleResult {
  const findings: RuleFinding[] = [];
  const url = meta.pageUrl;

  // ── Title ──
  const title = page.title;
  if (!title) {
    findings.push(
      observed(
        "ONPAGE.MISSING_TITLE",
        "Missing page title",
        "high",
        "No <title> tag found in the served HTML.",
        url,
        "Add a unique, descriptive <title> tag.",
      ),
    );
  } else if (title.length < 10) {
    findings.push(
      observed(
        "ONPAGE.TITLE_TOO_SHORT",
        `Title too short (${title.length} chars): "${title}"`,
        "medium",
        "A title under ~10 characters leaves SERP space unused and rarely describes the page.",
        url,
        "Expand to 30-60 characters covering the page's actual subject.",
      ),
    );
  } else if (title.length > 70) {
    findings.push(
      observed(
        "ONPAGE.TITLE_TOO_LONG",
        `Title too long (${title.length} chars)`,
        "low",
        "Search engines commonly truncate titles beyond ~70 characters.",
        url,
        "Trim to 50-60 characters.",
      ),
    );
  }

  // ── Meta description ──
  const metaDesc = page.metaDescription;
  if (!metaDesc) {
    findings.push(
      observed(
        "ONPAGE.MISSING_META_DESCRIPTION",
        "Missing meta description",
        "medium",
        "No meta description tag found.",
        url,
        "Add a unique meta description of 120-155 characters.",
      ),
    );
  } else if (metaDesc.length > 160) {
    findings.push(
      observed(
        "ONPAGE.META_DESC_TOO_LONG",
        `Meta description too long (${metaDesc.length} chars)`,
        "low",
        "Search engines may truncate meta descriptions beyond 160 characters.",
        url,
        "Trim to 120-155 characters.",
      ),
    );
  }

  // ── H1 ──
  const h1Count = page.h1.length;
  if (h1Count === 0) {
    findings.push(
      observed(
        "ONPAGE.MISSING_H1",
        "Missing H1 heading",
        "medium",
        "No <h1> tag found. An H1 signals the page's main topic.",
        url,
        "Add exactly one descriptive <h1>.",
      ),
    );
  } else if (h1Count > 1) {
    findings.push(
      observed(
        "ONPAGE.MULTIPLE_H1",
        `Multiple H1 headings (${h1Count})`,
        "low",
        `Found ${h1Count} <h1> tags; multiple H1s dilute the main-topic signal.`,
        url,
        "Use one H1 and demote the others to H2+.",
      ),
    );
  }

  // ── Canonical ──
  if (!page.canonical) {
    findings.push(
      observed(
        "TECH.MISSING_CANONICAL",
        "No canonical URL specified",
        "low",
        "No canonical link tag found; duplicate-URL consolidation is unspecified.",
        url,
        "Add a self-referencing canonical tag.",
      ),
    );
  } else if (page.canonical !== meta.finalUrl) {
    // Reported strictly as an observation about the document. Cross-domain
    // syndication or pagination can make this intentional, so no engine behaviour
    // is asserted (Blueprint §1.2: do not claim more than the data demonstrates).
    findings.push(
      observed(
        "TECH.CANONICAL_NOT_SELF_REFERENCING",
        "Canonical points to a different URL",
        "medium",
        `The served page at ${meta.finalUrl} declares canonical ${page.canonical}. ` +
          "This may be intentional (syndication, pagination). It is reported as observed, " +
          "not as evidence that any engine will discard this page.",
        url,
        "Confirm the canonical target is the intended preferred URL.",
      ),
    );
  }

  // ── Robots meta ──
  const robotsMeta = page.robotsMeta;
  if (robotsMeta?.toLowerCase().includes("noindex")) {
    findings.push(
      observed(
        "CRAWL.ROBOTS_NOINDEX",
        "Page has a noindex directive",
        "high",
        `The robots meta tag ("${robotsMeta}") includes 'noindex' — this page is excluded from indexing.`,
        url,
        "Remove the noindex directive if this page should appear in search.",
      ),
    );
  }

  // ── Structured data ──
  const invalidBlocks = page.structuredData.filter((b) => !b.isValid);
  for (const block of invalidBlocks) {
    findings.push(
      observed(
        "STRUCTURED_DATA.INVALID_JSON",
        "Invalid JSON-LD block",
        "medium",
        `A JSON-LD script block failed to parse as JSON${block.error ? ` (${block.error})` : ""}.`,
        url,
        "Fix the JSON syntax or remove the malformed block.",
      ),
    );
  }

  // ── Language / viewport ──
  if (!page.lang) {
    findings.push(
      observed(
        "ONPAGE.MISSING_HTML_LANG",
        "Missing lang attribute on <html>",
        "medium",
        "No lang attribute found on the <html> element; language-dependent rendering and " +
          "assistive technology cannot infer the document language.",
        url,
        'Add lang="fr" (or the document\'s actual language) to the <html> element.',
      ),
    );
  }
  if (!page.hasViewport) {
    findings.push(
      observed(
        "ONPAGE.MISSING_VIEWPORT",
        "Missing viewport meta tag",
        "low",
        'No <meta name="viewport"> found; mobile browsers may render a scaled desktop layout.',
        url,
        'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
      ),
    );
  }

  // ── Redirect chain observation (not an error in itself) ──
  if (meta.redirectChain.length > 0) {
    findings.push(
      observed(
        "CRAWL.REDIRECT_CHAIN",
        `Redirect chain of ${meta.redirectChain.length} hop(s)`,
        meta.redirectChain.length > 2 ? "medium" : "info",
        `Requested ${url} reached ${meta.finalUrl} via ${meta.redirectChain.length} redirect(s): ` +
          `${meta.redirectChain.join(" → ")} → ${meta.finalUrl}`,
        url,
        meta.redirectChain.length > 1
          ? "Point internal links directly at the final URL to shorten the chain."
          : "No action required for a single redirect.",
      ),
    );
  }

  // ── Evidence: reproducible snapshot metadata ──
  // content_hash + final_url let a later re-crawl prove whether the document changed,
  // which is what a verification gate compares against (Blueprint §11.2/§11.3).
  const evidence: EvidenceRecord[] = [
    {
      kind: "html_snapshot",
      sourceRef: url,
      finalUrl: meta.finalUrl,
      capturedAt: meta.capturedAt,
      httpStatus: meta.httpStatus,
      contentHash: meta.contentHash,
      contentLength: meta.contentLength,
      redirectChain: meta.redirectChain,
      summary:
        `HTML snapshot of ${url}: title="${title ?? "(missing)"}", ` +
        `meta_desc="${metaDesc ?? "(missing)"}", h1_count=${h1Count}, ` +
        `canonical=${page.canonical ?? "(none)"}, robots_meta=${robotsMeta ?? "(none)"}, ` +
        `jsonld_blocks=${page.structuredData.length}, invalid_jsonld=${invalidBlocks.length}, ` +
        `lang=${page.lang ?? "(missing)"}, viewport=${page.hasViewport ? "present" : "missing"}, ` +
        `internal_links=${page.internalLinks.length}, content_hash=${meta.contentHash.slice(0, 16)}`,
    },
  ];

  return { findings, evidence };
}
