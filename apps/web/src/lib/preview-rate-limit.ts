export interface PreviewRateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** In-memory guard for the short-lived, non-production inline audit path. */
export function createPreviewRateLimiter(limit: number, windowMs: number) {
  const timestamps = new Map<string, number[]>();

  return {
    hit(key: string, now = Date.now()): PreviewRateDecision {
      const active = (timestamps.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);
      if (active.length >= limit) {
        const retryAt = (active[0] ?? now) + windowMs;
        timestamps.set(key, active);
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)),
        };
      }

      active.push(now);
      timestamps.set(key, active);

      // Bound process memory if a preview receives many unique source addresses.
      if (timestamps.size > 2048) {
        for (const [storedKey, values] of timestamps) {
          if (!values.some((timestamp) => now - timestamp < windowMs)) timestamps.delete(storedKey);
          if (timestamps.size <= 1536) break;
        }
      }

      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}
