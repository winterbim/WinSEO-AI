// Serverless-safe audit exports. The browser renderer lives behind the main
// crawler entry point and is intentionally not pulled into preview audit bundles.
export { normalizeUrl, normalizeAuditTarget, UrlNormalizationError } from "./url-normalizer.ts";
export type { NormalizedUrl } from "./url-normalizer.ts";
export { guardUrl, isPrivateIp, validateHostname, SsrfError, MAX_REDIRECTS } from "./ssrf-guard.ts";
export { createHttpFetcher, fetchPage } from "./http-fetcher.ts";
export type { FetcherOptions, FetchResult } from "./http-fetcher.ts";
export { parseHtmlPage, stripTags } from "./html-parser.ts";
export type { ParsedPage } from "./html-parser.ts";
export { parseRobotsTxt, isUrlAllowed, getCrawlDelay, parseSitemapXml } from "./sitemap-parser.ts";
export type { RobotsTxtRules, SitemapEntry } from "./sitemap-parser.ts";
export {
  evaluatePageRules,
  RULES_VERSION,
  RULE_VERIFICATION_GATES,
  gateForRule,
} from "./seo-rules.ts";
export type { PageMeta, RuleFinding, RuleResult, EvidenceRecord } from "./seo-rules.ts";
export { shouldRender } from "./render-escalation.ts";
export type { EscalationDecision } from "./render-escalation.ts";
export {
  groupSitePageStructures,
  groupSitePagesByTemplate,
  semanticDomSignature,
} from "./site-template.ts";
export type {
  SitePageShape,
  SitePageStructure,
  SiteTemplateGroup,
  SiteTemplateGrouping,
} from "./site-template.ts";
export { compareSourceRender, describeDivergences } from "./render-compare.ts";
export type { FieldDivergence, RenderComparison } from "./render-compare.ts";
export type { RenderResult } from "./renderer.ts";
