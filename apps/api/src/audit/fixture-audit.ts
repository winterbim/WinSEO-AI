import { createHash } from "node:crypto";
import type { FetchResult, NormalizedUrl, RenderResult } from "@serpvera/crawler";
import { auditDomain } from "./domain-audit.ts";
import { auditSite, type SiteAuditOptions } from "./site-audit.ts";

const FIXTURE_BODY =
  "This deterministic fixture explains a local product, how its public documentation works, " +
  "which integrations are supported, and how the example content is structured for a reader. ".repeat(
    4,
  );

export function fixtureHtml(domain: string): string {
  return `<!doctype html><html lang="en"><head>
    <title>Fixture content page</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="canonical" href="https://${domain}/">
  </head><body><main><h1>Fixture documentation</h1><p>${FIXTURE_BODY}</p></main></body></html>`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureFetch(url: NormalizedUrl): Promise<FetchResult> {
  const body = fixtureHtml(url.hostname);
  return Promise.resolve({
    url,
    finalUrl: url.normalized,
    httpStatus: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body,
    contentHash: hash(body),
    redirectChain: [],
    fetchDurationMs: 1,
  });
}

function fixtureRender(url: string): Promise<RenderResult> {
  const html = fixtureHtml(new URL(url).hostname);
  return Promise.resolve({
    ok: true,
    dom: html,
    sha256: hash(html),
    bytes: Buffer.byteLength(html),
    durationMs: 1,
  });
}

/** Test-only composition: real audit rules over deterministic, in-process HTML. */
export function createFixtureAuditRunner(): typeof auditDomain {
  return (domain, traceId) =>
    auditDomain(domain, traceId, {
      fetchPage: fixtureFetch,
      render: fixtureRender,
    });
}

/** Route fixture adapter: retain real deterministic rules without network I/O. */
export function createFixtureSiteAuditRunner(): typeof auditSite {
  const runFixture = createFixtureAuditRunner();
  return async (target, traceId, options?: SiteAuditOptions) => {
    const result = await runFixture(target, traceId);
    const secondUrl = new URL("/about", target).href;
    return {
      status: result.status,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      pagesCrawled: result.status === "completed" ? 2 : 0,
      pagesFailed: result.status === "failed" ? 1 : 0,
      pageLimit: options?.maxPages ?? 50,
      findings: [
        ...result.findings,
        ...result.findings.map((finding) => ({ ...finding, affectedUrls: [secondUrl] })),
      ],
      evidence: [
        ...result.evidence,
        ...result.evidence.map((item) => ({
          ...item,
          sourceRef: secondUrl,
          finalUrl: secondUrl,
          summary: item.summary.replace(target, secondUrl),
        })),
      ],
    };
  };
}
