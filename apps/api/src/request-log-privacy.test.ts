import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { serializeRequestForLogs } from "./server.ts";

void describe("request log privacy", () => {
  void it("omits query parameters that may contain OAuth codes and state", () => {
    const serialized = serializeRequestForLogs({
      method: "GET",
      url: "/v1/gsc/oauth/callback?code=secret-code&state=secret-state",
      hostname: "example.test",
      remoteAddress: "127.0.0.1",
      remotePort: 12345,
    });

    assert.deepEqual(serialized, {
      method: "GET",
      url: "/v1/gsc/oauth/callback",
      hostname: "example.test",
      remoteAddress: "127.0.0.1",
      remotePort: 12345,
    });
    assert.equal(JSON.stringify(serialized).includes("secret-code"), false);
    assert.equal(JSON.stringify(serialized).includes("secret-state"), false);
  });

  void it("keeps useful path information when a request has no query string", () => {
    assert.equal(
      serializeRequestForLogs({ method: "GET", url: "/v1/projects/123" }).url,
      "/v1/projects/123",
    );
  });
});
