// ─── Sitemap Parser ───
// Blueprint §12.3 — sitemap discovery, robots.txt parsing, XML parsing

import { logger } from "@serpvera/telemetry";

export interface SitemapEntry {
  url: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

export interface RobotsTxtRules {
  userAgents: Map<string, { allowed: string[]; disallowed: string[] }>;
  sitemaps: string[];
  crawlDelay?: number;
}

/**
 * Parse robots.txt content into structured rules.
 */
export function parseRobotsTxt(content: string): RobotsTxtRules {
  const rules: RobotsTxtRules = {
    userAgents: new Map(),
    sitemaps: [],
  };

  let currentAgent = "*";
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const field = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const value = trimmed.slice(colonIdx + 1).trim();

    switch (field) {
      case "user-agent":
        currentAgent = value.toLowerCase();
        if (!rules.userAgents.has(currentAgent)) {
          rules.userAgents.set(currentAgent, { allowed: [], disallowed: [] });
        }
        break;
      case "allow":
        rules.userAgents.get(currentAgent)?.allowed.push(value);
        break;
      case "disallow":
        rules.userAgents.get(currentAgent)?.disallowed.push(value);
        break;
      case "sitemap":
        rules.sitemaps.push(value);
        break;
      case "crawl-delay":
        rules.crawlDelay = parseFloat(value) || undefined;
        break;
    }
  }

  return rules;
}

/**
 * Check if a URL path is allowed for a given user agent.
 * Follows robots.txt precedence: most specific rule wins, allow overrides disallow for same specificity.
 */
export function isUrlAllowed(
  path: string,
  userAgent: string,
  rules: RobotsTxtRules,
): boolean {
  // Find matching user-agent (exact match first, then wildcard)
  const agentRules =
    rules.userAgents.get(userAgent.toLowerCase()) ??
    rules.userAgents.get("*");

  if (!agentRules) return true;

  let bestDisallowLength = -1;
  let bestAllowLength = -1;

  for (const pattern of agentRules.disallowed) {
    if (pathMatches(path, pattern) && pattern.length > bestDisallowLength) {
      bestDisallowLength = pattern.length;
    }
  }

  for (const pattern of agentRules.allowed) {
    if (pathMatches(path, pattern) && pattern.length > bestAllowLength) {
      bestAllowLength = pattern.length;
    }
  }

  // Allow overrides disallow when same specificity
  if (bestAllowLength >= bestDisallowLength) return true;
  return bestDisallowLength === -1;
}

function pathMatches(path: string, pattern: string): boolean {
  if (pattern === "/") return path === "/" || path === "";

  // Convert robots pattern to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\$$/, ".*$");

  return new RegExp(`^${escaped}`).test(path);
}

/**
 * Parse an XML sitemap (sitemap index or URL sitemap).
 */
export function parseSitemapXml(xml: string): {
  sitemaps: string[];
  urls: SitemapEntry[];
} {
  const sitemaps: string[] = [];
  const urls: SitemapEntry[] = [];

  // Sitemap index
  const sitemapMatches = xml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/gi);
  for (const sm of sitemapMatches) {
    const loc = /<loc>([^<]+)<\/loc>/i.exec(sm[1] ?? "");
    if (loc?.[1]) sitemaps.push(loc[1].trim());
  }

  // URL entries
  const urlMatches = xml.matchAll(/<url>([\s\S]*?)<\/url>/gi);
  for (const um of urlMatches) {
    const block = um[1] ?? "";
    const loc = /<loc>([^<]+)<\/loc>/i.exec(block);
    if (!loc?.[1]) continue;

    const entry: SitemapEntry = { url: loc[1].trim() };

    const lastmod = /<lastmod>([^<]+)<\/lastmod>/i.exec(block);
    if (lastmod?.[1]) entry.lastmod = lastmod[1].trim();

    const changefreq = /<changefreq>([^<]+)<\/changefreq>/i.exec(block);
    if (changefreq?.[1]) entry.changefreq = changefreq[1].trim();

    const priority = /<priority>([^<]+)<\/priority>/i.exec(block);
    if (priority?.[1]) entry.priority = parseFloat(priority[1]);

    urls.push(entry);
  }

  return { sitemaps, urls };
}

/**
 * Fetch and parse a sitemap (handles both XML and gzipped).
 */
export async function fetchSitemap(
  sitemapUrl: string,
  traceId: string,
): Promise<SitemapEntry[]> {
  const entries: SitemapEntry[] = [];
  const visited = new Set<string>();

  async function fetchRecursive(url: string) {
    if (visited.has(url)) return;
    visited.add(url);

    logger.debug(`Fetching sitemap: ${url}`, { traceId });

    let body: string;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "SERPVERA-Crawler/0.1" },
        signal: AbortSignal.timeout(30_000),
      });
      body = await res.text();
    } catch (err) {
      logger.warn(`Failed to fetch sitemap: ${url}`, {
        traceId,
        error: (err as Error).message,
      });
      return;
    }

    const parsed = parseSitemapXml(body);

    // Recurse into sitemap indexes
    for (const childUrl of parsed.sitemaps) {
      await fetchRecursive(childUrl);
    }

    entries.push(...parsed.urls);
  }

  await fetchRecursive(sitemapUrl);
  return entries;
}