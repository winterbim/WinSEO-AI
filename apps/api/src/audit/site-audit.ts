import {
  createHttpFetcher,
  evaluatePageRules,
  getCrawlDelay,
  guardUrl,
  isUrlAllowed,
  normalizeAuditTarget,
  normalizeUrl,
  parseHtmlPage,
  parseRobotsTxt,
  parseSitemapXml,
  RULES_VERSION,
  type EvidenceRecord,
  type FetchResult,
  type NormalizedUrl,
  type RuleFinding,
} from "@serpvera/crawler/audit-core";

const MAX_PAGES = 200;
const MAX_SITEMAP_FILES = 5;
const MAX_SITEMAP_URLS = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_REQUEST_INTERVAL_MS = 1_000;
const MAX_CRAWL_DELAY_MS = 60_000;
const ROBOTS_USER_AGENT = "serpvera-crawler/0.1";

export interface SiteAuditResult {
  status: "completed" | "failed";
  errorMessage?: string;
  stopReason?:
    "robots_unavailable" | "robots_blocked" | "server_throttled" | "time_budget" | "page_limit";
  pagesCrawled: number;
  pagesFailed: number;
  pageLimit: number;
  findings: RuleFinding[];
  evidence: EvidenceRecord[];
}

export interface SiteAuditOptions {
  /** Maximum HTML pages to inspect, clamped to the hard maximum of 200. */
  maxPages?: number;
  /** End the run after this many milliseconds, with a 5 minute hard maximum. */
  maxDurationMs?: number;
  /** Deterministic fixture seam. Never permitted in production. */
  fetchPage?: (url: NormalizedUrl, requestOptions?: { timeoutMs?: number }) => Promise<FetchResult>;
  /** Deterministic fixture seam. Never permitted in production. */
  sleep?: (milliseconds: number) => Promise<void>;
}

function failedFinding(
  ruleId: string,
  title: string,
  url: string,
  explanation: string,
): RuleFinding {
  return {
    ruleId,
    title,
    epistemicClass: "OBSERVED",
    severity: ruleId === "CRAWL.SSRF_BLOCKED" ? "critical" : "high",
    explanation,
    affectedUrls: [url],
    ruleVersion: RULES_VERSION,
  };
}

function sameOrigin(candidate: string, origin: string): boolean {
  try {
    return new URL(candidate).origin === origin;
  } catch {
    return false;
  }
}

/** Return a reason when a redirect must be refused by the site audit policy. */
export function siteAuditRedirectBlockReason(
  targetOrigin: string,
  destinationUrl: string,
  robotsRules: ReturnType<typeof parseRobotsTxt>,
  robotsReadComplete: boolean,
): string | null {
  if (!sameOrigin(destinationUrl, targetOrigin)) return "destination leaves audited origin";
  // Before the first robots response is parsed, the only request in progress
  // is the robots.txt fetch itself. Allow its same-origin canonical redirects;
  // no page or sitemap request is issued until this fetch completes.
  if (!robotsReadComplete) return null;

  try {
    const destination = new URL(destinationUrl);
    const path = `${destination.pathname}${destination.search}`;
    return isUrlAllowed(path, ROBOTS_USER_AGENT, robotsRules)
      ? null
      : "destination is disallowed by robots.txt";
  } catch {
    return "destination URL is invalid";
  }
}

/** Adapt the site audit's origin and robots checks to the HTTP fetcher hook. */
export function createSiteAuditRedirectPolicy(
  targetOrigin: string,
  getRules: () => ReturnType<typeof parseRobotsTxt>,
  isRobotsReadComplete: () => boolean,
): (fromUrl: string, destinationUrl: string) => boolean | string {
  return (_fromUrl, destinationUrl) =>
    siteAuditRedirectBlockReason(
      targetOrigin,
      destinationUrl,
      getRules(),
      isRobotsReadComplete(),
    ) ?? true;
}

/** Keep crawl-delay sleeps within the remaining wall-clock crawl budget. */
export function boundedRequestDelayMs(
  startedAt: number,
  durationLimitMs: number,
  previousRequestAt: number | null,
  requestIntervalMs: number,
  now: number,
): number | null {
  const remainingBudget = startedAt + durationLimitMs - now;
  if (remainingBudget <= 0) return null;
  const delay =
    previousRequestAt === null ? 0 : Math.max(0, requestIntervalMs - (now - previousRequestAt));
  return Math.min(delay, remainingBudget);
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function failedResult(
  url: string,
  errorMessage: string,
  stopReason: SiteAuditResult["stopReason"],
  pageLimit: number,
): SiteAuditResult {
  const securityFailure = /ssrf|private|not allowed|redirect refused/i.test(errorMessage);
  return {
    status: "failed",
    errorMessage,
    ...(stopReason ? { stopReason } : {}),
    pagesCrawled: 0,
    pagesFailed: 1,
    pageLimit,
    findings: [
      failedFinding(
        securityFailure ? "CRAWL.SSRF_BLOCKED" : "CRAWL.HTTP_ERROR",
        securityFailure ? "Crawl blocked by security policy" : "Site crawl could not start",
        url,
        errorMessage,
      ),
    ],
    evidence: [],
  };
}

/**
 * Bounded, single-origin HTTP crawl used by project audits. Every URL is
 * normalized and guarded; redirects are restricted to the original origin;
 * robots.txt is fetched before the first page; sitemap entries and links are
 * treated as untrusted input. This is an HTTP_FAST crawl, not a claim that all
 * URLs on a site have been discovered or that rendered-only content was seen.
 */
export async function auditSite(
  target: string,
  traceId: string,
  options: SiteAuditOptions = {},
): Promise<SiteAuditResult> {
  if (process.env.NODE_ENV === "production" && (options.fetchPage || options.sleep)) {
    throw new Error("Site audit fixture overrides are disabled in production.");
  }

  const pageLimit = boundedInteger(options.maxPages, 50, MAX_PAGES);
  const durationLimitMs = boundedInteger(options.maxDurationMs, 300_000, 300_000);
  let normalizedTarget: NormalizedUrl;
  try {
    normalizedTarget = normalizeAuditTarget(target);
    guardUrl(normalizedTarget.normalized);
  } catch (error) {
    return failedResult(
      target,
      `Target rejected by crawler policy: ${(error as Error).message}`,
      undefined,
      pageLimit,
    );
  }

  const targetOrigin = new URL(normalizedTarget.normalized).origin;
  let robotsRules = parseRobotsTxt("");
  let robotsReadComplete = false;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  const startedAt = Date.now();
  let previousRequestAt: number | null = null;
  let requestIntervalMs = DEFAULT_REQUEST_INTERVAL_MS;

  async function delayRedirectHop(_fromUrl: string, _toUrl: string, deadline: number) {
    const now = Date.now();
    const waitMs = boundedRequestDelayMs(
      startedAt,
      durationLimitMs,
      previousRequestAt,
      requestIntervalMs,
      now,
    );
    if (waitMs === null) throw new Error("crawl time budget expired before the redirect hop");
    if (waitMs >= deadline - now) {
      throw new Error("crawl delay exceeds the current per-request redirect budget");
    }
    if (waitMs > 0) await sleep(waitMs);
    previousRequestAt = Date.now();
  }

  const fetcher = createHttpFetcher({
    traceId,
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxResponseSizeBytes: MAX_RESPONSE_BYTES,
    userAgent: "SERPVERA-Crawler/0.1 (+https://serpvera.dev/bot)",
    allowRedirect: createSiteAuditRedirectPolicy(
      targetOrigin,
      () => robotsRules,
      () => robotsReadComplete,
    ),
    // The fetcher follows redirects internally, so apply the same per-origin
    // request interval at every hop rather than only between top-level URLs.
    beforeRedirect: delayRedirectHop,
  });
  const fetchPage = options.fetchPage ?? fetcher.fetchPage;

  async function request(url: string): Promise<FetchResult | null> {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= durationLimitMs) return null;
    const waitMs = boundedRequestDelayMs(
      startedAt,
      durationLimitMs,
      previousRequestAt,
      requestIntervalMs,
      Date.now(),
    );
    if (waitMs === null) return null;
    if (waitMs > 0) await sleep(waitMs);
    if (Date.now() - startedAt >= durationLimitMs) return null;
    previousRequestAt = Date.now();
    const requestBudgetMs = Math.min(
      REQUEST_TIMEOUT_MS,
      durationLimitMs - (Date.now() - startedAt),
    );
    if (requestBudgetMs <= 0) return null;
    return fetchPage(normalizeUrl(url), { timeoutMs: requestBudgetMs });
  }

  const robotsUrl = new URL("/robots.txt", targetOrigin).href;
  let robotsResult: FetchResult;
  try {
    const fetched = await request(robotsUrl);
    robotsReadComplete = true;
    if (!fetched) {
      return failedResult(
        target,
        "The crawl time budget expired before robots.txt was read.",
        "time_budget",
        pageLimit,
      );
    }
    robotsResult = fetched;
  } catch (error) {
    robotsReadComplete = true;
    return failedResult(
      target,
      `robots.txt could not be safely fetched: ${(error as Error).message}`,
      "robots_unavailable",
      pageLimit,
    );
  }

  if (robotsResult.error) {
    return failedResult(
      target,
      `robots.txt could not be fetched: ${robotsResult.error}`,
      "robots_unavailable",
      pageLimit,
    );
  }
  if (robotsResult.httpStatus === 404 || robotsResult.httpStatus === 410) {
    // RFC-compatible absence: there is no robots policy document to apply.
  } else if (robotsResult.httpStatus >= 200 && robotsResult.httpStatus < 300) {
    const body = robotsResult.body ?? "";
    const contentType = robotsResult.headers["content-type"]?.toLowerCase() ?? "";
    if (
      Buffer.byteLength(body, "utf8") > 512 * 1024 ||
      (contentType && !contentType.includes("text/plain"))
    ) {
      return failedResult(
        target,
        "robots.txt returned an invalid or oversized response; the crawl stopped without guessing its rules.",
        "robots_unavailable",
        pageLimit,
      );
    }
    robotsRules = parseRobotsTxt(body);
    const configuredDelay = getCrawlDelay(ROBOTS_USER_AGENT, robotsRules);
    if (configuredDelay !== undefined && configuredDelay > 0) {
      requestIntervalMs = Math.max(DEFAULT_REQUEST_INTERVAL_MS, Math.ceil(configuredDelay * 1_000));
      if (requestIntervalMs > MAX_CRAWL_DELAY_MS) {
        return failedResult(
          target,
          "robots.txt requests a crawl delay above the supported one-minute limit.",
          "robots_unavailable",
          pageLimit,
        );
      }
    }
  } else {
    return failedResult(
      target,
      `robots.txt returned HTTP ${robotsResult.httpStatus}; the crawl stopped without assuming access is allowed.`,
      "robots_unavailable",
      pageLimit,
    );
  }

  const normalizeScopedUrl = (raw: string, baseUrl: string): string | null => {
    try {
      const resolved = new URL(raw, baseUrl);
      resolved.hash = "";
      if (resolved.username || resolved.password || resolved.origin !== targetOrigin) return null;
      const normalized = normalizeUrl(resolved.href);
      guardUrl(normalized.normalized);
      const path = `${normalized.pathname}${normalized.search}`;
      if (!isUrlAllowed(path, ROBOTS_USER_AGENT, robotsRules)) return null;
      return normalized.normalized;
    } catch {
      return null;
    }
  };

  const sitemapQueue: string[] = [];
  const sitemapSeeds =
    robotsRules.sitemaps.length > 0
      ? robotsRules.sitemaps.slice(0, MAX_SITEMAP_FILES)
      : [new URL("/sitemap.xml", targetOrigin).href];
  for (const sitemap of sitemapSeeds) {
    const scoped = normalizeScopedUrl(sitemap, robotsUrl);
    if (scoped && !sitemapQueue.includes(scoped)) sitemapQueue.push(scoped);
  }

  const sitemapSeen = new Set<string>();
  const sitemapUrls: string[] = [];
  while (sitemapQueue.length > 0 && sitemapSeen.size < MAX_SITEMAP_FILES) {
    const sitemapUrl = sitemapQueue.shift();
    if (!sitemapUrl || sitemapSeen.has(sitemapUrl)) continue;
    sitemapSeen.add(sitemapUrl);
    const sitemapResponse = await request(sitemapUrl);
    if (!sitemapResponse) break;
    if (
      sitemapResponse.error ||
      sitemapResponse.httpStatus < 200 ||
      sitemapResponse.httpStatus >= 300
    ) {
      if (sitemapResponse.httpStatus === 429 || sitemapResponse.httpStatus === 503) {
        return failedResult(
          target,
          `Sitemap request was throttled (HTTP ${sitemapResponse.httpStatus}).`,
          "server_throttled",
          pageLimit,
        );
      }
      continue;
    }
    const parsed = parseSitemapXml(sitemapResponse.body ?? "");
    for (const child of parsed.sitemaps) {
      const scoped = normalizeScopedUrl(child, sitemapUrl);
      if (scoped && !sitemapSeen.has(scoped) && !sitemapQueue.includes(scoped))
        sitemapQueue.push(scoped);
    }
    for (const entry of parsed.urls) {
      const scoped = normalizeScopedUrl(entry.url, sitemapUrl);
      if (scoped && !sitemapUrls.includes(scoped)) {
        sitemapUrls.push(scoped);
        if (sitemapUrls.length >= MAX_SITEMAP_URLS) break;
      }
    }
    if (sitemapUrls.length >= MAX_SITEMAP_URLS) break;
  }

  const initialPage = normalizeScopedUrl(normalizedTarget.normalized, normalizedTarget.normalized);
  if (!initialPage) {
    return failedResult(
      target,
      "The submitted page is disallowed by robots.txt or outside the audited origin.",
      "robots_blocked",
      pageLimit,
    );
  }

  const queue = [...new Set([initialPage, ...sitemapUrls])];
  const queued = new Set(queue);
  const visited = new Set<string>();
  const finalUrls = new Set<string>();
  const findings: RuleFinding[] = [];
  const evidence: EvidenceRecord[] = [];
  let pagesCrawled = 0;
  let pagesFailed = 0;
  let stopReason: SiteAuditResult["stopReason"];

  while (queue.length > 0 && pagesCrawled + pagesFailed < pageLimit) {
    if (Date.now() - startedAt >= durationLimitMs) {
      stopReason = "time_budget";
      break;
    }
    const pageUrl = queue.shift();
    if (!pageUrl || visited.has(pageUrl)) continue;
    visited.add(pageUrl);

    let result: FetchResult;
    try {
      const fetched = await request(pageUrl);
      if (!fetched) {
        stopReason = "time_budget";
        break;
      }
      result = fetched;
    } catch (error) {
      pagesFailed++;
      findings.push(
        failedFinding(
          "CRAWL.HTTP_ERROR",
          "Unable to fetch page",
          pageUrl,
          (error as Error).message,
        ),
      );
      continue;
    }

    if (result.httpStatus === 429 || result.httpStatus === 503) {
      pagesFailed++;
      stopReason = "server_throttled";
      break;
    }
    if (result.error) {
      pagesFailed++;
      const robotsFailure = /disallowed by robots\.txt/i.test(result.error);
      const securityFailure =
        !robotsFailure &&
        /ssrf|blocked|redirect refused|not allowed|leaves audited origin/i.test(result.error);
      findings.push(
        failedFinding(
          robotsFailure
            ? "CRAWL.ROBOTS_BLOCKED"
            : securityFailure
              ? "CRAWL.SSRF_BLOCKED"
              : "CRAWL.HTTP_ERROR",
          robotsFailure
            ? "Redirect target disallowed by robots.txt"
            : securityFailure
              ? "Page refused by crawl security policy"
              : "Unable to fetch page",
          pageUrl,
          result.error,
        ),
      );
      continue;
    }
    if (!sameOrigin(result.finalUrl, targetOrigin)) {
      pagesFailed++;
      findings.push(
        failedFinding(
          "CRAWL.SSRF_BLOCKED",
          "Redirect left the audited origin",
          pageUrl,
          "The final URL is outside the submitted origin; its content was discarded.",
        ),
      );
      continue;
    }
    if (finalUrls.has(result.finalUrl)) continue;
    finalUrls.add(result.finalUrl);

    const body = result.body ?? "";
    const contentType = result.headers["content-type"]?.toLowerCase() ?? "";
    if (result.httpStatus < 200 || result.httpStatus >= 300) {
      pagesFailed++;
      findings.push(
        failedFinding(
          "CRAWL.HTTP_ERROR",
          `Page returned HTTP ${result.httpStatus}`,
          pageUrl,
          `Observed HTTP ${result.httpStatus} while fetching ${pageUrl}.`,
        ),
      );
      continue;
    }
    if (
      !body ||
      (contentType &&
        !contentType.includes("text/html") &&
        !contentType.includes("application/xhtml+xml"))
    ) {
      pagesFailed++;
      findings.push(
        failedFinding(
          "CRAWL.NON_HTML",
          "Page did not return HTML",
          pageUrl,
          `Observed content type ${contentType || "(missing)"}; no HTML page rules were inferred.`,
        ),
      );
      continue;
    }

    const capturedAt = new Date().toISOString();
    const parsed = parseHtmlPage(body, result.finalUrl);
    const pageAudit = evaluatePageRules(parsed, {
      pageUrl,
      finalUrl: result.finalUrl,
      httpStatus: result.httpStatus,
      contentHash: result.contentHash,
      redirectChain: result.redirectChain,
      contentLength: Buffer.byteLength(body, "utf8"),
      capturedAt,
    });
    findings.push(...pageAudit.findings);
    evidence.push(...pageAudit.evidence);
    pagesCrawled++;

    for (const linked of parsed.internalLinks) {
      const scoped = normalizeScopedUrl(linked, result.finalUrl);
      if (
        scoped &&
        !queued.has(scoped) &&
        !visited.has(scoped) &&
        queue.length < MAX_SITEMAP_URLS
      ) {
        queued.add(scoped);
        queue.push(scoped);
      }
    }
  }

  if (!stopReason && queue.length > 0 && pagesCrawled + pagesFailed >= pageLimit) {
    stopReason = "page_limit";
  }

  if (pagesCrawled === 0) {
    const reason =
      stopReason === "server_throttled"
        ? "The site throttled the crawl before an HTML page could be observed."
        : stopReason === "time_budget"
          ? "The crawl time budget expired before an HTML page could be observed."
          : "No accessible HTML page was observed.";
    return {
      status: "failed",
      errorMessage: reason,
      ...(stopReason ? { stopReason } : {}),
      pagesCrawled,
      pagesFailed: Math.max(1, pagesFailed),
      pageLimit,
      findings,
      evidence,
    };
  }

  return {
    status: stopReason && stopReason !== "page_limit" ? "failed" : "completed",
    ...(stopReason === "server_throttled"
      ? { errorMessage: "The site throttled the crawl; partial observations were retained." }
      : stopReason === "time_budget"
        ? { errorMessage: "The crawl time budget expired; partial observations were retained." }
        : stopReason === "page_limit"
          ? { errorMessage: "The page limit was reached; observations are partial." }
          : {}),
    ...(stopReason ? { stopReason } : {}),
    pagesCrawled,
    pagesFailed,
    pageLimit,
    findings,
    evidence,
  };
}
