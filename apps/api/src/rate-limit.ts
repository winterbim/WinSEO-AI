// ─── Public-scan rate limiter (P-GAP-06) ───
//
// Blueprint §19.1: rate limits per tenant AND global. This is the global/IP
// layer for the ANONYMOUS public scan endpoint — the only unauthenticated
// write path in the product, and the one that triggers outbound crawls.
//
// The production DB store uses the PostgreSQL-backed atomic counter in
// packages/db/src/rate-limit.ts. This in-process implementation is only the
// explicit memory-store adapter for tests and local fixtures.
// - Fixed window, keyed by client IP. PostgreSQL shares quota across API
//   instances; memory mode is deliberately process-local.
// - The counter increments ONLY when a scan would actually be created
//   (post-validation). Requests rejected by input validation or the SSRF guard
//   cost nothing downstream and do not consume quota.
// - Loopback addresses are exempt: they are the local operator/dev, cannot be
//   spoofed from outside, and exempting them keeps local proofs repeatable.
// - Bounded memory: entries older than the window are evicted on access and a
//   hard cap drops the coldest entries when the map grows too large.

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export type RateLimitScope =
  "public-scan-ip" | "mfa-ip" | "auth-login-ip" | "auth-register-ip" | "project-crawl-org";

interface WindowEntry {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_TRACKED_IPS = 10_000; // hard memory cap

export function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip.startsWith("127.");
}

export interface RateLimiter {
  /** Record an attempt from `ip` in one operation-specific window. */
  hit(ip: string, scope?: RateLimitScope): RateLimitDecision;
  /** Return one quota unit when admission fails after a successful hit. */
  release(ip: string, scope?: RateLimitScope): void;
  /** Current remaining quota without consuming (for headers). */
  peek(ip: string, scope?: RateLimitScope): number;
  /** Test helper: drop all state. */
  reset(): void;
}

export function createRateLimiter(
  limitPerWindow: number,
  now: () => number = Date.now,
): RateLimiter {
  const windows = new Map<string, WindowEntry>();

  function current(ip: string, scope: RateLimitScope): WindowEntry {
    const t = now();
    const key = `${scope}\0${ip}`;
    const existing = windows.get(key);
    if (existing && t - existing.windowStart < WINDOW_MS) return existing;
    const fresh: WindowEntry = { count: 0, windowStart: t };
    windows.set(key, fresh);

    // Bound memory: drop expired entries, then oldest if still over cap.
    if (windows.size > MAX_TRACKED_IPS) {
      for (const [key, entry] of windows) {
        if (t - entry.windowStart >= WINDOW_MS) windows.delete(key);
      }
      while (windows.size > MAX_TRACKED_IPS) {
        const oldest = windows.keys().next();
        if (oldest.done) break;
        windows.delete(oldest.value);
      }
    }
    return fresh;
  }

  return {
    hit(ip, scope = "public-scan-ip") {
      if (isLoopback(ip)) {
        return { allowed: true, remaining: limitPerWindow, retryAfterSeconds: 0 };
      }
      const entry = current(ip, scope);
      if (entry.count >= limitPerWindow) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((entry.windowStart + WINDOW_MS - now()) / 1000),
        );
        return { allowed: false, remaining: 0, retryAfterSeconds };
      }
      entry.count += 1;
      return {
        allowed: true,
        remaining: limitPerWindow - entry.count,
        retryAfterSeconds: 0,
      };
    },
    release(ip, scope = "public-scan-ip") {
      if (isLoopback(ip)) return;
      const entry = current(ip, scope);
      entry.count = Math.max(0, entry.count - 1);
    },
    peek(ip, scope = "public-scan-ip") {
      if (isLoopback(ip)) return limitPerWindow;
      const entry = current(ip, scope);
      return Math.max(0, limitPerWindow - entry.count);
    },
    reset() {
      windows.clear();
    },
  };
}
