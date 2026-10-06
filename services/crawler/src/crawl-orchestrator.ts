// ─── Crawl Orchestrator ───
// Blueprint §12 — orchestrates HTTP_FAST + RENDERED_ESCALATION two-pass crawling

import type { NormalizedUrl } from "./url-normalizer.ts";
import { normalizeUrl } from "./url-normalizer.ts";
import { createHttpFetcher, type FetcherOptions } from "./http-fetcher.ts";
import { parseHtmlPage } from "./html-parser.ts";
import { createMemoryEvidenceStore, type EvidenceStore, type EvidenceRecord } from "./evidence-store.ts";
import { logger, generateTraceId } from "@serpvera/telemetry";

export interface CrawlOptions {
  domain: string;
  maxPages: number;
  mode: "HTTP_FAST" | "FULL";
  fetcherOptions?: Partial<FetcherOptions>;
  evidenceStore?: EvidenceStore;
}

export interface CrawlResult {
  runId: string;
  domain: string;
  pagesCrawled: number;
  pagesFailed: number;
  pages: PageResult[];
  evidence: EvidenceRecord[];
  startedAt: string;
  completedAt: string;
}

export interface PageResult {
  normalizedUrl: NormalizedUrl;
  httpStatus: number;
  finalUrl: string;
  title: string | null;
  metaDescription: string | null;
  h1: string[];
  canonical: string | null;
  robotsMeta: string | null;
  contentHash: string;
  fetchDurationMs: number;
  error?: string;
}

/**
 * Run a crawl against a domain.
 * For Phase 3 MVP: HTTP_FAST only. RENDERED_ESCALATION requires Playwright infrastructure.
 */
export async function runCrawl(options: CrawlOptions): Promise<CrawlResult> {
  const traceId = generateTraceId();
  const startedAt = new Date().toISOString();
  const evidence = createMemoryEvidenceStore();
  const store = options.evidenceStore ?? evidence;
  const fetcher = createHttpFetcher({
    traceId,
    ...options.fetcherOptions,
  });

  const pages: PageResult[] = [];
  const evidenceRecords: EvidenceRecord[] = [];
  let pagesCrawled = 0;
  let pagesFailed = 0;

  // Seed: crawl homepage
  const seedUrl = `https://${options.domain}/`;
  const normalized = normalizeUrl(seedUrl);

  logger.info("Crawl started", {
    traceId,
    domain: options.domain,
    maxPages: options.maxPages,
    mode: options.mode,
  });

  // Crawl homepage
  const result = await fetcher.fetchPage(normalized);

  if (result.error) {
    pagesFailed++;
    pages.push({
      normalizedUrl: normalized,
      httpStatus: 0,
      finalUrl: result.finalUrl,
      title: null,
      metaDescription: null,
      h1: [],
      canonical: null,
      robotsMeta: null,
      contentHash: "",
      fetchDurationMs: result.fetchDurationMs,
      error: result.error,
    });
  } else {
    pagesCrawled++;
    const parsed = result.body ? parseHtmlPage(result.body, result.finalUrl) : null;

    // Store evidence
    if (result.body) {
      const orgId = "public"; // no auth for free scans
      const projId = options.domain;
      const now = new Date().toISOString();

      const htmlEvidence = await store.store(
        {
          organizationId: orgId,
          projectId: projId,
          kind: "html_snapshot",
          sourceRef: result.finalUrl,
          capturedAt: now,
          metadata: { httpStatus: result.httpStatus, contentHash: result.contentHash },
        },
        result.body,
      );
      evidenceRecords.push(htmlEvidence);
    }

    pages.push({
      normalizedUrl: normalized,
      httpStatus: result.httpStatus,
      finalUrl: result.finalUrl,
      title: parsed?.title ?? null,
      metaDescription: parsed?.metaDescription ?? null,
      h1: parsed?.h1 ?? [],
      canonical: parsed?.canonical ?? null,
      robotsMeta: parsed?.robotsMeta ?? null,
      contentHash: result.contentHash,
      fetchDurationMs: result.fetchDurationMs,
    });
  }

  logger.info("Crawl completed", {
    traceId,
    pagesCrawled,
    pagesFailed,
    durationMs: Date.now() - new Date(startedAt).getTime(),
  });

  return {
    runId: traceId,
    domain: options.domain,
    pagesCrawled,
    pagesFailed,
    pages,
    evidence: evidenceRecords,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}