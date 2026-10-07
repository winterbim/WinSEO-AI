// ─── Shared API rate-limit storage ───
// The API passes an HMAC fingerprint of the requester IP. Raw IP addresses
// are never persisted. The single UPSERT serializes concurrent hits across
// API instances and preserves the first-hit fixed-window semantics.

import { query } from "./client.ts";

export interface RateLimitWindowHit {
  count: number;
  retryAfterSeconds: number;
}

export async function consumeRateLimitWindow(
  bucketKey: string,
  limitPerWindow: number,
): Promise<RateLimitWindowHit> {
  if (!Number.isInteger(limitPerWindow) || limitPerWindow < 1) {
    throw new Error("Rate limit must be a positive integer.");
  }

  // Opportunistic retention cleanup. The expiry index keeps this cheap when
  // there is little stale data; the 24-hour grace avoids racing active windows.
  await query(
    `DELETE FROM rate_limit_windows
      WHERE expires_at < now() - interval '24 hours'`,
  );

  // Sampled hard-cap sweep: HMAC keys are evenly distributed, so roughly one
  // in 256 requests trims the oldest-expiring rows when cardinality exceeds
  // the in-memory adapter's 10k safety bound. Keep this request's bucket.
  if (bucketKey.endsWith("00")) {
    await query(
      `DELETE FROM rate_limit_windows
        WHERE bucket_key IN (
          SELECT bucket_key
            FROM rate_limit_windows
           WHERE bucket_key <> $1
           ORDER BY expires_at ASC
           OFFSET 9999
        )`,
      [bucketKey],
    );
  }

  const { rows } = await query<{
    request_count: number;
    retry_after_seconds: number;
  }>(
    `INSERT INTO rate_limit_windows (bucket_key, request_count, expires_at)
     VALUES ($1, 1, now() + interval '1 hour')
     ON CONFLICT (bucket_key) DO UPDATE SET
       request_count = CASE
         WHEN rate_limit_windows.expires_at <= now() THEN 1
         ELSE LEAST(rate_limit_windows.request_count + 1, $2::integer + 1)
       END,
       expires_at = CASE
         WHEN rate_limit_windows.expires_at <= now() THEN now() + interval '1 hour'
         ELSE rate_limit_windows.expires_at
       END
     RETURNING request_count,
       GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - now()))))::integer
         AS retry_after_seconds`,
    [bucketKey, limitPerWindow],
  );

  const row = rows[0];
  if (!row) throw new Error("Rate limit hit did not return an updated window.");
  return {
    count: row.request_count,
    retryAfterSeconds: row.retry_after_seconds,
  };
}
