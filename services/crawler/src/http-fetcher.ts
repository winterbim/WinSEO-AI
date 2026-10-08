// ─── HTTP Fetcher ───
// Blueprint §12 — HTTP_FAST pass crawler

import type { NormalizedUrl } from "./url-normalizer.ts";
import { guardUrl, MAX_REDIRECTS } from "./ssrf-guard.ts";
import { isPrivateIp } from "./ssrf-guard.ts";
import { logger } from "@serpvera/telemetry";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export interface FetcherOptions {
  timeoutMs: number;
  maxResponseSizeBytes: number;
  userAgent: string;
  acceptLanguage: string;
  traceId: string;
  /**
   * Injectable DNS resolution. Defaults to node:dns/promises lookup(all).
   * Tests override this to exercise connection-time validation (rebinding and
   * per-hop redirect checks) deterministically without real network access.
   * This never weakens production behaviour: it is only ever supplied in tests.
   */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Controlled transport override for tests; production callers use pinned HTTP. */
  fetchImpl?: typeof fetch;
  /** Optional restrictive redirect policy, evaluated before each redirect hop. */
  allowRedirect?: (fromUrl: string, toUrl: string) => boolean | string;
  /** Optional per-hop politeness hook; runs before any redirected request. */
  beforeRedirect?: (fromUrl: string, toUrl: string, deadline: number) => void | Promise<void>;
}

interface HttpResponse {
  status: number;
  headers: Headers;
  text(): Promise<string>;
  oversizeBytes?: number;
}

export interface FetchResult {
  url: NormalizedUrl;
  finalUrl: string;
  httpStatus: number;
  headers: Record<string, string>;
  body: string | null;
  contentHash: string;
  redirectChain: string[];
  fetchDurationMs: number;
  error?: string;
}

const DEFAULT_OPTIONS: FetcherOptions = {
  timeoutMs: 30_000,
  maxResponseSizeBytes: 10 * 1024 * 1024, // 10 MB
  userAgent: "SERPVERA-Crawler/0.1 (+https://serpvera.dev/bot)",
  acceptLanguage: "en,fr;q=0.9",
  traceId: "",
};

/** DNS-resolve a host and reject the answer if any A/AAAA address is private. */
async function resolveAndValidate(
  hostname: string,
  traceId: string,
  resolve?: (hostname: string) => Promise<string[]>,
): Promise<string[]> {
  let addresses: string[];
  if (resolve) {
    addresses = await resolve(hostname);
  } else {
    const { lookup } = await import("node:dns/promises");
    addresses = (await lookup(hostname, { all: true, verbatim: true })).map(
      (record) => record.address,
    );
  }

  const first = addresses[0];
  if (first === undefined) {
    throw new Error(`No IP addresses resolved for ${hostname}`);
  }

  // Reject the complete answer set. Accepting a public first address while
  // ignoring a private additional A record can leave alternate connection
  // paths to an internal target.
  for (const ip of addresses) {
    const check = isPrivateIp(ip);
    if (check.blocked) {
      logger.warn(`SSRF: resolved IP ${ip} is blocked (${check.reason})`, {
        traceId,
        jobType: "crawler",
      });
      throw new Error(`SSRF blocked: ${check.reason} (${ip})`);
    }
  }

  return addresses;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error("Operation timed out."), { name: "AbortError" }));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Pins Node's connection-time lookup to the already validated address. The
 * requested hostname remains in the URL, preserving Host and TLS certificate
 * verification while preventing a second DNS answer from changing the socket
 * destination.
 */
export function createPinnedLookup(expectedHostname: string, pinnedIp: string): LookupFunction {
  const expected = expectedHostname.toLowerCase();
  const family = isIP(pinnedIp);
  if (!family) throw new Error("Pinned address must be a valid IP address.");

  return (hostname, options, callback) => {
    if (hostname.toLowerCase() !== expected) {
      const error = Object.assign(new Error("Pinned DNS lookup received an unexpected hostname."), {
        code: "EHOSTUNREACH",
      });
      callback(error, pinnedIp, family);
      return;
    }
    if (options.all) {
      callback(null, [{ address: pinnedIp, family }]);
      return;
    }
    callback(null, pinnedIp, family);
  };
}

export function createResponseDecoder(encoding: string | null): Transform | null {
  const normalized = encoding?.trim().toLowerCase();
  if (!normalized || normalized === "identity") return null;
  if (normalized === "gzip" || normalized === "x-gzip") return createGunzip();
  if (normalized === "deflate") return createInflate();
  if (normalized === "br") return createBrotliDecompress();
  throw new Error(`Unsupported content encoding: ${normalized}`);
}

function responseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(response.headers)) {
    if (rawValue === undefined) continue;
    headers.set(name, Array.isArray(rawValue) ? rawValue.join(", ") : rawValue);
  }
  return headers;
}

function nativePinnedRequest(
  url: string,
  pinnedIp: string,
  opts: FetcherOptions,
  signal: AbortSignal,
): Promise<HttpResponse> {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const lookup = createPinnedLookup(hostname, pinnedIp);
  const options = {
    hostname,
    port: parsed.port ? Number(parsed.port) : undefined,
    path: `${parsed.pathname}${parsed.search}`,
    method: "GET" as const,
    headers: {
      "User-Agent": opts.userAgent,
      "Accept-Language": opts.acceptLanguage,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "close",
      Host: parsed.host,
    },
    agent: false as const,
    lookup,
    signal,
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const finish = (response: HttpResponse) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };

    const onResponse = (incoming: IncomingMessage) => {
      const headers = responseHeaders(incoming);
      const status = incoming.statusCode ?? 0;
      const emptyResponse = (): HttpResponse => ({
        status,
        headers,
        text: () => Promise.resolve(""),
      });

      // Redirect bodies are irrelevant: each redirect is re-validated and
      // re-resolved before a new pinned request is made.
      if ([301, 302, 303, 307, 308].includes(status)) {
        finish(emptyResponse());
        incoming.destroy();
        return;
      }

      const declaredLength = Number.parseInt(headers.get("content-length") ?? "", 10);
      if (Number.isFinite(declaredLength) && declaredLength > opts.maxResponseSizeBytes) {
        finish({ ...emptyResponse(), oversizeBytes: declaredLength });
        incoming.destroy();
        return;
      }

      let decoder: Transform | null;
      try {
        decoder = createResponseDecoder(headers.get("content-encoding"));
      } catch (error) {
        fail(error as Error);
        incoming.destroy();
        return;
      }
      const bodyStream = decoder ? incoming.pipe(decoder) : incoming;

      const chunks: Buffer[] = [];
      let bytes = 0;
      bodyStream.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > opts.maxResponseSizeBytes) {
          finish({ ...emptyResponse(), oversizeBytes: bytes });
          bodyStream.destroy();
          incoming.destroy();
          return;
        }
        chunks.push(buffer);
      });
      bodyStream.on("end", () => {
        if (settled) return;
        const text = Buffer.concat(chunks).toString("utf8");
        finish({ status, headers, text: () => Promise.resolve(text) });
      });
      incoming.on("aborted", () => {
        fail(new Error("Response aborted before completion."));
      });
      incoming.on("error", fail);
      if (decoder) decoder.on("error", fail);
    };

    const request =
      parsed.protocol === "https:"
        ? httpsRequest(
            {
              ...options,
              ...(isIP(hostname) ? {} : { servername: hostname }),
            },
            onResponse,
          )
        : httpRequest(options, onResponse);
    request.on("error", (error) => {
      fail(error);
    });
    request.end();
  });
}

/**
 * Create an HTTP fetcher with SSRF protection and a pinned socket destination
 * for every request. Redirects are validated and pinned independently.
 */
export function createHttpFetcher(options: Partial<FetcherOptions> = {}) {
  if (process.env.NODE_ENV === "production" && (options.resolve || options.fetchImpl)) {
    throw new Error("Crawler transport overrides are disabled in production.");
  }
  const opts = { ...DEFAULT_OPTIONS, ...options };

  return {
    fetchPage,
  };

  async function fetchPage(
    normalized: NormalizedUrl,
    requestOptions: { timeoutMs?: number } = {},
  ): Promise<FetchResult> {
    const startTime = Date.now();
    const requestTimeoutMs = Math.max(1, Math.floor(requestOptions.timeoutMs ?? opts.timeoutMs));
    const deadline = startTime + requestTimeoutMs;
    const redirectChain: string[] = [];
    let redirectCount = 0;

    // Initial SSRF guard
    guardUrl(normalized.normalized);

    async function doFetch(url: string): Promise<FetchResult> {
      if (redirectCount > MAX_REDIRECTS) {
        return {
          url: normalized,
          finalUrl: url,
          httpStatus: 0,
          headers: {},
          body: null,
          contentHash: "",
          redirectChain,
          fetchDurationMs: Date.now() - startTime,
          error: `Exceeded max redirects (${MAX_REDIRECTS})`,
        };
      }

      const parsed = new URL(url);

      // SSRF guard on every hop (redirect chain)
      guardUrl(url);

      // Resolve every A/AAAA record once, reject any private result, then pin
      // Node's socket lookup to one member of that validated answer set.
      let addresses: string[];
      const dnsTimeBudget = deadline - Date.now();
      if (dnsTimeBudget <= 0) {
        return {
          url: normalized,
          finalUrl: url,
          httpStatus: 0,
          headers: {},
          body: null,
          contentHash: "",
          redirectChain,
          fetchDurationMs: Date.now() - startTime,
          error: "Request timeout",
        };
      }
      try {
        const resolution = resolveAndValidate(
          parsed.hostname.replace(/^\[|\]$/g, ""),
          opts.traceId,
          opts.resolve,
        );
        addresses = await withTimeout(resolution, dnsTimeBudget);
      } catch (err) {
        return {
          url: normalized,
          finalUrl: url,
          httpStatus: 0,
          headers: {},
          body: null,
          contentHash: "",
          redirectChain,
          fetchDurationMs: Date.now() - startTime,
          error: `DNS/SSRF error: ${(err as Error).message}`,
        };
      }

      const networkTimeBudget = deadline - Date.now();
      if (networkTimeBudget <= 0) {
        return {
          url: normalized,
          finalUrl: url,
          httpStatus: 0,
          headers: {},
          body: null,
          contentHash: "",
          redirectChain,
          fetchDurationMs: Date.now() - startTime,
          error: "Request timeout",
        };
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, networkTimeBudget);

      try {
        const pinnedIp = addresses[0];
        if (!pinnedIp) throw new Error("No validated address is available.");
        const response: HttpResponse = opts.fetchImpl
          ? await opts.fetchImpl(url, {
              method: "GET",
              headers: {
                "User-Agent": opts.userAgent,
                "Accept-Language": opts.acceptLanguage,
                Accept: "text/html,application/xhtml+xml",
              },
              redirect: "manual",
              signal: controller.signal,
            })
          : await nativePinnedRequest(url, pinnedIp, opts, controller.signal);

        if (response.oversizeBytes !== undefined) {
          clearTimeout(timeout);
          return {
            url: normalized,
            finalUrl: url,
            httpStatus: response.status,
            headers: {},
            body: null,
            contentHash: "",
            redirectChain,
            fetchDurationMs: Date.now() - startTime,
            error: `Response too large (${response.oversizeBytes} > ${opts.maxResponseSizeBytes})`,
          };
        }

        // Convert headers to plain object
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });

        // Handle redirects
        const status = response.status;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.get("location");
          if (location) {
            redirectChain.push(url);
            redirectCount++;
            // Resolve relative redirects
            const redirectUrl = new URL(location, url).href;
            const redirectDecision = opts.allowRedirect?.(url, redirectUrl);
            if (redirectDecision === false || typeof redirectDecision === "string") {
              clearTimeout(timeout);
              return {
                url: normalized,
                finalUrl: url,
                httpStatus: status,
                headers,
                body: null,
                contentHash: "",
                redirectChain,
                fetchDurationMs: Date.now() - startTime,
                error:
                  typeof redirectDecision === "string"
                    ? `Redirect refused: ${redirectDecision}`
                    : "Redirect refused by the configured crawl-scope policy.",
              };
            }
            clearTimeout(timeout);
            try {
              await opts.beforeRedirect?.(url, redirectUrl, deadline);
            } catch (err) {
              return {
                url: normalized,
                finalUrl: url,
                httpStatus: status,
                headers,
                body: null,
                contentHash: "",
                redirectChain,
                fetchDurationMs: Date.now() - startTime,
                error: `Redirect preparation failed: ${(err as Error).message}`,
              };
            }
            // `return await` inside try/catch so a failed redirect hop is
            // reported through the SAME structured error result as every
            // other failure in this block instead of escaping as a raw
            // rejection the caller may not handle.
            return await doFetch(redirectUrl);
          }
        }

        // Read body with size cap
        const contentLength = parseInt(response.headers.get("content-length") ?? "0", 10);
        if (contentLength > opts.maxResponseSizeBytes) {
          clearTimeout(timeout);
          return {
            url: normalized,
            finalUrl: url,
            httpStatus: status,
            headers,
            body: null,
            contentHash: "",
            redirectChain,
            fetchDurationMs: Date.now() - startTime,
            error: `Response too large (${contentLength} > ${opts.maxResponseSizeBytes})`,
          };
        }

        const text = await response.text();
        clearTimeout(timeout);

        // Check actual size after reading
        const actualSize = Buffer.byteLength(text, "utf-8");
        if (actualSize > opts.maxResponseSizeBytes) {
          return {
            url: normalized,
            finalUrl: url,
            httpStatus: status,
            headers,
            body: null,
            contentHash: "",
            redirectChain,
            fetchDurationMs: Date.now() - startTime,
            error: `Response too large (${actualSize} > ${opts.maxResponseSizeBytes})`,
          };
        }

        // Compute content hash
        const { createHash } = await import("node:crypto");
        const contentHash = createHash("sha256").update(text).digest("hex");

        return {
          url: normalized,
          finalUrl: url,
          httpStatus: status,
          headers,
          body: text,
          contentHash,
          redirectChain,
          fetchDurationMs: Date.now() - startTime,
        };
      } catch (err) {
        clearTimeout(timeout);
        const errorMsg =
          (err as Error).name === "AbortError" ? "Request timeout" : (err as Error).message;
        return {
          url: normalized,
          finalUrl: url,
          httpStatus: 0,
          headers: {},
          body: null,
          contentHash: "",
          redirectChain,
          fetchDurationMs: Date.now() - startTime,
          error: errorMsg,
        };
      }
    }

    return doFetch(normalized.normalized);
  }
}

/**
 * Convenience function: normalize + guard + fetch in one call.
 */
export async function fetchPage(url: string): Promise<FetchResult> {
  // Import normalize to avoid circular dependency at module level
  const { normalizeUrl } = await import("./url-normalizer.ts");
  const normalized = normalizeUrl(url);
  const fetcher = createHttpFetcher();
  return fetcher.fetchPage(normalized);
}
