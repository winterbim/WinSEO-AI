import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { containsOAuthCredentialLog, scanOAuthLogFile } from "./oauth-log-privacy-check.mjs";

void describe("OAuth request log scanner", () => {
  void it("accepts a callback request after the entire query string is stripped", () => {
    assert.equal(
      containsOAuthCredentialLog(
        '{"req":{"url":"/v1/gsc/oauth/callback"},"msg":"request completed"}',
      ),
      false,
    );
  });

  void it("rejects a callback query even when parameter names are encoded", () => {
    assert.equal(
      containsOAuthCredentialLog('{"req":{"url":"/v1/gsc/oauth/callback?%2563ode%3Dsecret"}}'),
      true,
    );
  });

  void it("rejects structured code and state fields", () => {
    assert.equal(containsOAuthCredentialLog('{"req":{"code":"secret-code"}}'), true);
    assert.equal(containsOAuthCredentialLog('{"req":{"state":"secret-state"}}'), true);
    assert.equal(
      containsOAuthCredentialLog(
        '{"req":{"query":{"code":["secret-code"],"state":["secret-state"]}}}',
      ),
      true,
    );
    assert.equal(
      containsOAuthCredentialLog('{"req":{"query":{"code":{"values":["secret-code"]}}}}'),
      true,
    );
  });

  void it("rejects JSON-stringified and percent-encoded credential objects inside log fields", () => {
    assert.equal(
      containsOAuthCredentialLog(
        '{"req":{"query":"{\\"code\\":\\"secret-code\\",\\"state\\":\\"secret-state\\"}"}}',
      ),
      true,
    );
    assert.equal(
      containsOAuthCredentialLog(
        '{"req":{"query":"%257B%2522code%2522%253A%2522secret-code%2522%257D"}}',
      ),
      true,
    );
  });

  void it("fails closed when a log field remains percent-encoded beyond the decode limit", () => {
    let encoded = JSON.stringify({ code: "secret-code" });
    for (let pass = 0; pass < 21; pass += 1) encoded = encodeURIComponent(encoded);
    assert.equal(containsOAuthCredentialLog(JSON.stringify({ req: { query: encoded } })), true);
  });

  void it("fails closed on malformed percent encoding at every bounded decode boundary", () => {
    for (const layers of [1, 9, 10]) {
      let malformed = `${JSON.stringify({ code: "secret-code", state: "secret-state" })}%`;
      for (let pass = 0; pass < layers; pass += 1) malformed = encodeURIComponent(malformed);
      assert.equal(
        containsOAuthCredentialLog(JSON.stringify({ req: { query: malformed } })),
        true,
        `malformed credentials must fail closed after ${layers} encoding layers`,
      );
    }
  });

  void it("rejects a code or state query on any logged request URL", () => {
    assert.equal(containsOAuthCredentialLog("GET /oauth/return?code=secret"), true);
    assert.equal(containsOAuthCredentialLog("GET /oauth/return?state=secret"), true);
  });

  void it("fails closed on unreadable logs and detects matching content without exposing it", () => {
    const tempDirectory = mkdtempSync(`${tmpdir()}/oauth-log-check-`);
    try {
      const missingPath = `${tempDirectory}/missing.log`;
      assert.throws(() => scanOAuthLogFile(missingPath), { code: "ENOENT" });

      const logPath = `${tempDirectory}/route.log`;
      writeFileSync(logPath, "GET /v1/gsc/oauth/callback?code=fixture-secret\n");
      assert.equal(scanOAuthLogFile(logPath), true);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
