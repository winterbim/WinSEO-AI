import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { closePool, configurePool, consumeRateLimitWindow, withAdmin } from "./index.ts";

const key = `rate-limit-test-${process.pid}-${Date.now()}`;

void describe("shared PostgreSQL rate-limit windows", () => {
  before(() => {
    configurePool({
      host: process.env.PG_SOCKET_DIR ?? "/var/run/postgresql",
      database: process.env.PGDATABASE ?? "serpvera_dev",
      maxPool: 8,
    });
  });

  after(async () => {
    try {
      await withAdmin(async (client) => {
        await client.query(`DELETE FROM rate_limit_windows WHERE bucket_key = $1`, [key]);
      });
    } finally {
      await closePool();
    }
  });

  void it("serializes concurrent attempts across API instances through atomic UPSERTs", async () => {
    const hits = await Promise.all(Array.from({ length: 8 }, () => consumeRateLimitWindow(key, 5)));
    const observedCounts = hits.map((hit) => hit.count).sort((a, b) => a - b);

    assert.deepEqual(observedCounts, [1, 2, 3, 4, 5, 6, 6, 6]);
    assert.ok(hits.every((hit) => hit.retryAfterSeconds > 0));
  });
});
