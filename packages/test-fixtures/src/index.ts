// ─── SSRF Test Corpus ───
// Blueprint §12.2, §24.2 — every URL in this set MUST be blocked by the SSRF guard.
// A new SSRF vector discovered = new fixture added here.

export interface SsrfTestCase {
  url: string;
  description: string;
  mustBeBlocked: true;
}

export const SSRF_CORPUS: SsrfTestCase[] = [
  // Loopback
  { url: "http://127.0.0.1:8080/admin", description: "IPv4 loopback", mustBeBlocked: true },
  { url: "http://[::1]:8080/admin", description: "IPv6 loopback", mustBeBlocked: true },
  { url: "http://localhost:3000", description: "localhost hostname", mustBeBlocked: true },
  { url: "http://0.0.0.0:8080", description: "Unspecified address", mustBeBlocked: true },

  // RFC1918 private ranges
  { url: "http://10.0.0.1:8080", description: "10.0.0.0/8", mustBeBlocked: true },
  { url: "http://172.16.0.1:8080", description: "172.16.0.0/12", mustBeBlocked: true },
  { url: "http://192.168.1.1:8080", description: "192.168.0.0/16", mustBeBlocked: true },

  // Link-local
  { url: "http://169.254.169.254/latest/meta-data/", description: "AWS metadata endpoint", mustBeBlocked: true },
  { url: "http://169.254.169.254", description: "Link-local range", mustBeBlocked: true },

  // Cloud metadata
  { url: "http://metadata.google.internal", description: "GCP metadata", mustBeBlocked: true },
  { url: "http://169.254.169.254/computeMetadata/v1/", description: "GCP metadata IP", mustBeBlocked: true },

  // CGNAT
  { url: "http://100.64.0.1:8080", description: "100.64.0.0/10 (CGNAT)", mustBeBlocked: true },

  // Multicast
  { url: "http://224.0.0.1:8080", description: "Multicast range", mustBeBlocked: true },

  // Non-HTTP protocols
  { url: "file:///etc/passwd", description: "file:// protocol", mustBeBlocked: true },
  { url: "ftp://internal.server/file", description: "ftp:// protocol", mustBeBlocked: true },
  { url: "gopher://localhost:70", description: "gopher:// protocol", mustBeBlocked: true },

  // Embedded credentials
  { url: "http://admin:password@example.com", description: "URL with credentials", mustBeBlocked: true },
];

// ─── Safe URLs (should NOT be blocked) ───
export interface SafeUrlTestCase {
  url: string;
  description: string;
}

export const SAFE_URLS: SafeUrlTestCase[] = [
  { url: "https://example.com", description: "Normal HTTPS URL" },
  { url: "https://www.example.com/page?q=test", description: "URL with query params" },
  { url: "http://example.com", description: "Normal HTTP URL" },
  { url: "https://sub.domain.example.co.uk/path/to/page", description: "Complex subdomain" },
];

// ─── HTML Fixtures for deterministic rule testing ───

export interface HtmlFixture {
  name: string;
  html: string;
  expectedFindings: string[]; // rule IDs that should fire
}

export const CANONICAL_CONFLICT_FIXTURE: HtmlFixture = {
  name: "canonical-conflict",
  html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Canonical Conflict Page</title>
  <meta name="description" content="A page with canonical conflict">
  <link rel="canonical" href="https://example.com/different-page">
</head>
<body>
  <h1>Conflict Page</h1>
  <p>This page has a canonical pointing to a different URL than the sitemap.</p>
</body>
</html>`,
  expectedFindings: ["TECH.CANONICAL.CONFLICT"],
};

export const DUPLICATE_TITLE_FIXTURE: HtmlFixture = {
  name: "duplicate-titles",
  html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Same Title</title>
  <meta name="description" content="Page with duplicate title">
</head>
<body>
  <h1>Page One</h1>
  <p>Content here.</p>
</body>
</html>`,
  expectedFindings: ["ONPAGE.DUPLICATE_TITLE"],
};

export const MISSING_DESCRIPTION_FIXTURE: HtmlFixture = {
  name: "missing-description",
  html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Complete Page</title>
</head>
<body>
  <h1>Hello World</h1>
  <p>This page has no meta description.</p>
</body>
</html>`,
  expectedFindings: ["ONPAGE.MISSING_META_DESCRIPTION"],
};

export const ROBOTS_NOINDEX_FIXTURE: HtmlFixture = {
  name: "robots-noindex",
  html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>No-Index Page</title>
  <meta name="robots" content="noindex, nofollow">
</head>
<body>
  <h1>Hidden Page</h1>
  <p>This page has noindex.</p>
</body>
</html>`,
  expectedFindings: ["CRAWL.ROBOTS_NOINDEX"],
};

export const INVALID_STRUCTURED_DATA_FIXTURE: HtmlFixture = {
  name: "invalid-structured-data",
  html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Structured Data Test</title>
  <script type="application/ld+json">
    { "broken json
  </script>
</head>
<body>
  <h1>Structured Data Page</h1>
  <p>This page has invalid JSON-LD.</p>
</body>
</html>`,
  expectedFindings: ["STRUCTURED_DATA.INVALID_JSON"],
};

// ─── All fixtures ───
export const ALL_HTML_FIXTURES: HtmlFixture[] = [
  CANONICAL_CONFLICT_FIXTURE,
  DUPLICATE_TITLE_FIXTURE,
  MISSING_DESCRIPTION_FIXTURE,
  ROBOTS_NOINDEX_FIXTURE,
  INVALID_STRUCTURED_DATA_FIXTURE,
];