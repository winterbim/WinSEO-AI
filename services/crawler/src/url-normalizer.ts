// ─── URL Normalization ───
// Blueprint §12.1

const MAX_URL_LENGTH = 2048;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export interface NormalizedUrl {
  original: string;
  normalized: string;
  protocol: string;
  hostname: string;
  port: number | null;
  pathname: string;
  search: string;
  hash: string; // always empty after normalization
}

export class UrlNormalizationError extends Error {
  readonly originalUrl: string;

  constructor(message: string, originalUrl: string) {
    super(`URL normalization error: ${message}`);
    this.name = "UrlNormalizationError";
    this.originalUrl = originalUrl;
  }
}

/**
 * Normalize a URL per Blueprint §12.1:
 * - Accept only http/https
 * - IDNA/punycode normalized (handled by URL constructor)
 * - Fragment removed
 * - Host/port canonicalized
 * - No embedded credentials
 * - Length capped
 * - Query preserved (business params not arbitrarily removed)
 */
export function normalizeUrl(raw: string): NormalizedUrl {
  if (raw.length > MAX_URL_LENGTH) {
    throw new UrlNormalizationError(`URL exceeds max length of ${MAX_URL_LENGTH}`, raw);
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UrlNormalizationError("Invalid URL format", raw);
  }

  // Protocol allowlist
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new UrlNormalizationError(
      `Protocol ${parsed.protocol} not allowed (only http/https)`,
      raw,
    );
  }

  // No embedded credentials
  if (parsed.username || parsed.password) {
    throw new UrlNormalizationError("URL must not contain credentials", raw);
  }

  const normalized = new URL(parsed.href);
  // Remove fragment
  normalized.hash = "";
  // Canonicalize: lowercase hostname
  normalized.hostname = normalized.hostname.toLowerCase();
  // Remove default ports
  if (
    (normalized.protocol === "https:" && normalized.port === "443") ||
    (normalized.protocol === "http:" && normalized.port === "80")
  ) {
    normalized.port = "";
  }

  return {
    original: raw,
    normalized: normalized.href,
    protocol: normalized.protocol,
    hostname: normalized.hostname,
    port: normalized.port ? parseInt(normalized.port, 10) : null,
    pathname: normalized.pathname,
    search: normalized.search,
    hash: normalized.hash,
  };
}

/**
 * Normalize a visitor-entered audit target. Bare domains default to HTTPS;
 * complete HTTP(S) URLs retain their path and query so a visitor can test the
 * exact public page they entered.
 */
export function normalizeAuditTarget(raw: string): NormalizedUrl {
  const value = raw.trim();
  if (!value) throw new UrlNormalizationError("URL is required", raw);
  if (value.length > MAX_URL_LENGTH) {
    throw new UrlNormalizationError(`URL exceeds max length of ${MAX_URL_LENGTH}`, raw);
  }

  const hasHttpScheme = /^https?:\/\//i.test(value);
  const hasOtherScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value) && !hasHttpScheme;
  if (hasOtherScheme) {
    throw new UrlNormalizationError("Only HTTP and HTTPS URLs are allowed", raw);
  }

  return normalizeUrl(hasHttpScheme ? value : `https://${value}`);
}
