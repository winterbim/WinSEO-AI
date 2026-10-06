// ─── HTML Parser ───
// Blueprint §13 — deterministic HTML analysis
// Extracts: title, meta description, H1, canonical, robots meta, structured data, links

export interface ParsedPage {
  title: string | null;
  metaDescription: string | null;
  h1: string[];
  canonical: string | null;
  robotsMeta: string | null;
  structuredData: StructuredDataItem[];
  internalLinks: string[];
  lang: string | null;
  hasViewport: boolean;
}

export interface StructuredDataItem {
  type: string | null;
  json: unknown;
  isValid: boolean;
  error?: string;
}

// Lightweight regex-based HTML parser.
// Does NOT use a full DOM parser — deterministic and fast.
// For JS-rendered pages, the Playwright renderer handles extraction.

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const META_DESC_RE = /<meta\s+[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["'][^>]*>/i;
const META_DESC_RE2 = /<meta\s+[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["'][^>]*>/i;
const CANONICAL_RE = /<link\s+[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']*)["'][^>]*>/i;
const CANONICAL_RE2 = /<link\s+[^>]*href\s*=\s*["']([^"']*)["'][^>]*rel\s*=\s*["']canonical["'][^>]*>/i;
const ROBOTS_META_RE = /<meta\s+[^>]*name\s*=\s*["']robots["'][^>]*content\s*=\s*["']([^"']*)["'][^>]*>/i;
const ROBOTS_META_RE2 = /<meta\s+[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']robots["'][^>]*>/i;
const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/gi;
const HREF_RE = /<a\s+[^>]*href\s*=\s*["']([^"']*)["'][^>]*>/gi;
const HTML_LANG_RE = /<html[^>]*lang\s*=\s*["']([^"']*)["'][^>]*>/i;
const VIEWPORT_RE = /<meta\s+[^>]*name\s*=\s*["']viewport["'][^>]*>/i;
const JSON_LD_RE = /<script\s+[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Parse HTML content into structured page data.
 * This is the HTTP_FAST pass — deterministic, no LLM.
 */
export function parseHtmlPage(html: string, baseUrl: string): ParsedPage {
  // Title
  const titleMatch = TITLE_RE.exec(html);
  const title = titleMatch?.[1]?.trim() ?? null;

  // Meta description (try both attribute orderings)
  // NOTE: the fallback must also fire for a present-but-EMPTY attribute
  // (`content=""`), so the guard is the full falsy set for `string | undefined`
  // rather than `??=`, which would skip the empty-string case.
  let metaDesc = META_DESC_RE.exec(html)?.[1]?.trim();
  if (metaDesc === undefined || metaDesc === "") {
    metaDesc = META_DESC_RE2.exec(html)?.[1]?.trim();
  }
  const metaDescription = metaDesc ?? null;

  // H1 tags
  const h1: string[] = [];
  let h1Match: RegExpExecArray | null;
  while ((h1Match = H1_RE.exec(html)) !== null) {
    const text = h1Match[1]?.replace(/<[^>]*>/g, "").trim();
    if (text) h1.push(text);
  }

  // Canonical (try both attribute orderings; empty attribute must fall back too)
  let canonical = CANONICAL_RE.exec(html)?.[1]?.trim();
  if (canonical === undefined || canonical === "") {
    canonical = CANONICAL_RE2.exec(html)?.[1]?.trim();
  }
  const resolvedCanonical = canonical ? resolveUrl(canonical, baseUrl) : null;

  // Robots meta (empty attribute must fall back to the other ordering)
  let robotsMeta = ROBOTS_META_RE.exec(html)?.[1]?.trim();
  if (robotsMeta === undefined || robotsMeta === "") {
    robotsMeta = ROBOTS_META_RE2.exec(html)?.[1]?.trim();
  }
  const robotsMetaValue = robotsMeta ?? null;

  // Structured data (JSON-LD)
  const structuredData: StructuredDataItem[] = [];
  let jsonLdMatch: RegExpExecArray | null;
  while ((jsonLdMatch = JSON_LD_RE.exec(html)) !== null) {
    const raw = jsonLdMatch[1]?.trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        const type =
          typeof parsed === "object" && parsed !== null && "@type" in parsed
            ? (parsed as Record<string, unknown>)["@type"] as string
            : null;
        structuredData.push({ type, json: parsed, isValid: true });
      } catch {
        structuredData.push({
          type: null,
          json: null,
          isValid: false,
          error: "Invalid JSON-LD syntax",
        });
      }
    }
  }

  // Internal links
  const base = new URL(baseUrl);
  const internalLinks: string[] = [];
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = HREF_RE.exec(html)) !== null) {
    const href = linkMatch[1]?.trim();
    if (href && !href.startsWith("#") && !href.startsWith("javascript:") && !href.startsWith("mailto:")) {
      try {
        const resolved = new URL(href, baseUrl);
        if (resolved.hostname === base.hostname) {
          internalLinks.push(resolved.href);
        }
      } catch {
        // Skip malformed URLs
      }
    }
  }

  // HTML lang
  const langMatch = HTML_LANG_RE.exec(html);
  const lang = langMatch?.[1]?.trim() ?? null;

  // Viewport
  const hasViewport = VIEWPORT_RE.test(html);

  return {
    title,
    metaDescription,
    h1,
    canonical: resolvedCanonical,
    robotsMeta: robotsMetaValue,
    structuredData,
    internalLinks,
    lang,
    hasViewport,
  };
}

function resolveUrl(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

/**
 * Strip HTML tags for text extraction (for content fingerprinting).
 */
export function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}