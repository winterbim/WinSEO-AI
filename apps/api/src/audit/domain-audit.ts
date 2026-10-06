// ─── Domain audit core (P-GAP-04) ───
// Single source of truth for "audit one submitted public page", shared by BOTH
// production paths: the anonymous public scan and the tenant project crawl.
// Deterministic only — no LLM (Blueprint §13).
//
// The SSRF chain is identical for both callers:
//   guardUrl → normalizeUrl → createHttpFetcher (per-hop guard + DNS re-resolve)
// Callers MUST have already rejected private targets synchronously before
// queueing (pre-queue guard); this function re-validates as defence in depth.

import {
  createHttpFetcher,
  evaluatePageRules,
  guardUrl,
  normalizeAuditTarget,
  normalizeUrl,
  parseHtmlPage,
  shouldRender,
  compareSourceRender,
  describeDivergences,
  RULES_VERSION,
  type FetchResult,
  type NormalizedUrl,
  type RuleFinding,
  type EvidenceRecord,
  type RenderResult,
} from "@serpvera/crawler/audit-core";

const SCAN_TIMEOUT_MS = 15_000;
// Blueprint §12.2: cap response size so a hostile/huge page cannot exhaust memory.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export interface RenderMeta {
  /** True when deterministic signals justified the render phase (the decision
   *  was made). Capture success is shown by renderedSha256; capture failure
   *  is shown by `error` — never silently conflated. */
  escalated: boolean;
  /** Persisted, explicit reasons — WHY rendering was triggered. */
  reasons: string[];
  renderedSha256?: string;
  renderedBytes?: number;
  /** Source-vs-render differences on compared fields (OBSERVED). */
  divergences: string[];
  /** Set when rendering was decided but could not run (browser/timeout). */
  error?: string;
  durationMs?: number;
}

export interface DomainAuditResult {
  status: "completed" | "failed";
  /** Set only when status === "failed"; surfaced to the caller as scan/run error. */
  errorMessage?: string;
  findings: RuleFinding[];
  evidence: EvidenceRecord[];
  httpStatus: number;
  finalUrl: string;
  contentHash: string;
  /** Present when the two-pass (HTTP_FAST → rendered escalation) path ran. */
  render?: RenderMeta;
}

export interface AuditOptions {
  /**
   * Injectable renderer (tests). Defaults to the Playwright renderer; false
   * explicitly records an unavailable rendered capture in constrained runtimes.
   */
  render?: ((url: string) => Promise<RenderResult>) | false;
  /**
   * Deterministic HTTP fixture seam for tests. Production callers must omit it
   * so the guarded crawler owns DNS validation, redirects, timeouts and limits.
   */
  fetchPage?: (url: NormalizedUrl) => Promise<FetchResult>;
}

function failedFinding(
  ruleId: string,
  title: string,
  severity: RuleFinding["severity"],
  explanation: string,
  url: string,
): RuleFinding {
  return {
    ruleId,
    title,
    epistemicClass: "OBSERVED",
    severity,
    explanation,
    affectedUrls: [url],
    ruleVersion: RULES_VERSION,
  };
}

export async function auditDomain(
  target: string,
  traceId: string,
  opts: AuditOptions = {},
): Promise<DomainAuditResult> {
  if (opts.fetchPage && process.env.NODE_ENV === "production") {
    throw new Error("Injected audit fetchers are disabled in production.");
  }
  let url: string;

  // Defence in depth: re-validate immediately before the network call.
  try {
    url = normalizeAuditTarget(target).normalized;
    guardUrl(url);
  } catch (ssrfErr) {
    url = target;
    return {
      status: "failed",
      errorMessage: (ssrfErr as Error).message,
      findings: [
        failedFinding(
          "CRAWL.SSRF_BLOCKED",
          `URL blocked by security policy: ${url}`,
          "critical",
          `SSRF guard rejected the URL before any network request: ${(ssrfErr as Error).message}`,
          url,
        ),
      ],
      evidence: [],
      httpStatus: 0,
      finalUrl: url,
      contentHash: "",
    };
  }

  let normalized;
  try {
    normalized = normalizeUrl(url);
  } catch (err) {
    return {
      status: "failed",
      errorMessage: (err as Error).message,
      findings: [
        failedFinding(
          "CRAWL.URL_REJECTED",
          `URL rejected: ${url}`,
          "critical",
          `URL normalization failed: ${(err as Error).message}`,
          url,
        ),
      ],
      evidence: [],
      httpStatus: 0,
      finalUrl: url,
      contentHash: "",
    };
  }

  // Use the shared crawler fetcher — NOT raw fetch():
  // it runs guardUrl on every redirect hop (Blueprint §12.2) instead of validating
  // only the initial URL, caps redirects at MAX_REDIRECTS, and enforces timeout +
  // response-size caps. A raw fetch with redirect:"follow" would let a public
  // domain 302 into 169.254.169.254 and bypass the pre-queue guard entirely.
  //
  // Note: the resolved IP is NOT pinned to the socket — fetch re-resolves the
  // hostname independently (TOCTOU). See docs/KNOWN_LIMITATIONS.md before
  // treating DNS rebinding as solved; egress isolation is still required.
  const fetcher = createHttpFetcher({
    timeoutMs: SCAN_TIMEOUT_MS,
    maxResponseSizeBytes: MAX_RESPONSE_BYTES,
    traceId,
  });

  const result = await (opts.fetchPage ?? fetcher.fetchPage)(normalized);

  if (result.error) {
    // Distinguish a security rejection from a benign network failure: an SSRF
    // rejection must never be reported as a mere connectivity problem.
    const isSecurityRejection = /SSRF|blocked|not allowed|credentials|max redirects/i.test(
      result.error,
    );
    return {
      status: "failed",
      errorMessage: result.error,
      findings: [
        isSecurityRejection
          ? failedFinding(
              "CRAWL.SSRF_BLOCKED",
              `Request blocked by security policy: ${url}`,
              "critical",
              `The crawler refused to complete this request: ${result.error}`,
              url,
            )
          : failedFinding(
              "CRAWL.HTTP_ERROR",
              `Unable to fetch ${url}`,
              "high",
              `Connection failed: ${result.error}`,
              url,
            ),
      ],
      evidence: [],
      httpStatus: 0,
      finalUrl: result.finalUrl,
      contentHash: "",
    };
  }

  const html = result.body;
  if (!html) {
    return {
      status: "completed",
      findings: [
        failedFinding(
          "CRAWL.NON_HTML",
          `Non-HTML response (status ${result.httpStatus})`,
          "medium",
          "The URL returned a non-HTML response.",
          url,
        ),
      ],
      evidence: [],
      httpStatus: result.httpStatus,
      finalUrl: result.finalUrl,
      contentHash: result.contentHash,
    };
  }

  // Parse with the shared crawler parser, then run the shared deterministic rule
  // engine. Both live in @serpvera/crawler so extraction and rule logic have
  // exactly one source of truth and are unit-tested without network access.
  const now = new Date().toISOString();
  const parsed = parseHtmlPage(html, result.finalUrl);
  const checks = evaluatePageRules(parsed, {
    pageUrl: url,
    finalUrl: result.finalUrl,
    httpStatus: result.httpStatus,
    contentHash: result.contentHash,
    redirectChain: result.redirectChain,
    contentLength: html.length,
    capturedAt: now,
  });

  const findings = [...checks.findings];
  const evidence = [...checks.evidence];

  // ─── Pass 2: rendered escalation, ONLY when deterministic signals justify it ───
  // HTTP_FAST above remains the default path; this block runs after a positive
  // escalation decision and records explicit reasons either way.
  const decision = shouldRender(parsed, html);
  let render: RenderMeta | undefined;

  if (decision.escalate) {
    const doRender =
      opts.render === false
        ? () =>
            Promise.resolve({
              ok: false as const,
              error: "Rendered capture is unavailable in this runtime.",
              durationMs: 0,
            })
        : (opts.render ??
          (() =>
            Promise.resolve({
              ok: false as const,
              error: "No rendered audit adapter is configured.",
              durationMs: 0,
            })));
    const rendered = await doRender(result.finalUrl);

    if (rendered.ok) {
      const comparison = compareSourceRender(parsed, rendered.dom, result.finalUrl);
      const divergenceTexts = comparison.divergences.map(
        (d) => `${d.field}: source="${d.source}" rendered="${d.rendered}"`,
      );

      if (comparison.divergences.length > 0) {
        findings.push({
          ruleId: "JS.SOURCE_RENDER_DIVERGENCE",
          title: `Source and rendered DOM differ (${comparison.divergences.length} field${comparison.divergences.length === 1 ? "" : "s"})`,
          epistemicClass: "OBSERVED",
          severity: "medium",
          explanation:
            `Rendering was triggered because: ${decision.reasons.join(" · ")}. ` +
            `After JavaScript execution the document differs on: ${describeDivergences(comparison.divergences)}. ` +
            `This is an observation about two documents, not a claim about any engine's behaviour.`,
          affectedUrls: [url],
          recommendation:
            "Serve critical head tags and primary content in the initial HTML (SSR/prerender/static generation) so any consumer of the raw response sees them.",
          ruleVersion: RULES_VERSION,
        });
      }

      // Evidence: rendered DOM capture persisted as hash + excerpt + reasons.
      evidence.push({
        kind: "dom_snapshot",
        sourceRef: result.finalUrl,
        finalUrl: result.finalUrl,
        capturedAt: new Date().toISOString(),
        httpStatus: result.httpStatus,
        contentHash: rendered.sha256,
        contentLength: rendered.bytes,
        redirectChain: result.redirectChain,
        summary:
          `Rendered DOM sha256=${rendered.sha256} bytes=${rendered.bytes} in ${rendered.durationMs}ms. ` +
          `Escalation reasons: ${decision.reasons.join(" · ")}. ` +
          `Divergences: ${describeDivergences(comparison.divergences)}.`,
        metadata: {
          escalationReasons: decision.reasons,
          sourceRenderedDivergences: divergenceTexts,
          renderedSha256: rendered.sha256,
          renderedBytes: rendered.bytes,
          renderDurationMs: rendered.durationMs,
          // Explicit truncation: full-DOM persistence awaits the object store
          // (see KNOWN_LIMITATIONS); hash makes the capture verifiable.
          domExcerpt: rendered.dom.slice(0, 2000),
          domExcerptTruncated: rendered.dom.length > 2000,
        },
      });

      render = {
        escalated: true,
        reasons: decision.reasons,
        renderedSha256: rendered.sha256,
        renderedBytes: rendered.bytes,
        divergences: divergenceTexts,
        durationMs: rendered.durationMs,
      };
    } else {
      // Rendering was DECIDED (signals justified it) but the capture failed —
      // `escalated` stays true because the decision WAS made; `error` records
      // honestly that no capture exists. Never faked as done.
      render = {
        escalated: true,
        reasons: decision.reasons,
        divergences: [],
        error: rendered.error,
        durationMs: rendered.durationMs,
      };
    }
  }

  return {
    status: "completed",
    findings,
    evidence,
    httpStatus: result.httpStatus,
    finalUrl: result.finalUrl,
    contentHash: result.contentHash,
    ...(render ? { render } : {}),
  };
}
