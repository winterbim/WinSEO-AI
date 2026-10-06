import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPreviewRateLimiter } from "./preview-rate-limit.ts";

void describe("preview audit rate limiter", () => {
  void it("allows up to the configured limit and then returns a retry delay", () => {
    const limiter = createPreviewRateLimiter(2, 60_000);
    assert.equal(limiter.hit("client", 1_000).allowed, true);
    assert.equal(limiter.hit("client", 2_000).allowed, true);
    assert.deepEqual(limiter.hit("client", 3_000), {
      allowed: false,
      retryAfterSeconds: 58,
    });
  });

  void it("expires entries after the window and isolates clients", () => {
    const limiter = createPreviewRateLimiter(1, 10_000);
    assert.equal(limiter.hit("first", 1_000).allowed, true);
    assert.equal(limiter.hit("second", 1_000).allowed, true);
    assert.equal(limiter.hit("first", 11_000).allowed, true);
  });
});
