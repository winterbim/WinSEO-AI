import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPrivateIp, validateHostname, guardUrl, SsrfError } from "./ssrf-guard.ts";
import { SSRF_CORPUS, SAFE_URLS } from "@serpvera/test-fixtures";

void describe("ssrf-guard", () => {
  void describe("isPrivateIp", () => {
    void it("blocks 127.0.0.1", () => {
      const result = isPrivateIp("127.0.0.1");
      assert.ok(result.blocked);
      assert.ok(result.reason);
    });

    void it("blocks 10.0.0.1", () => {
      const result = isPrivateIp("10.0.0.1");
      assert.ok(result.blocked);
    });

    void it("blocks 172.16.0.1", () => {
      const result = isPrivateIp("172.16.0.1");
      assert.ok(result.blocked);
    });

    void it("blocks 172.31.255.255", () => {
      const result = isPrivateIp("172.31.255.255");
      assert.ok(result.blocked);
    });

    void it("does not block 172.32.0.1", () => {
      const result = isPrivateIp("172.32.0.1");
      assert.ok(!result.blocked);
    });

    void it("blocks 192.168.1.1", () => {
      const result = isPrivateIp("192.168.1.1");
      assert.ok(result.blocked);
    });

    void it("blocks 169.254.169.254 (metadata)", () => {
      const result = isPrivateIp("169.254.169.254");
      assert.ok(result.blocked);
    });

    void it("blocks 0.0.0.0", () => {
      const result = isPrivateIp("0.0.0.0");
      assert.ok(result.blocked);
    });

    void it("blocks multicast 224.0.0.1", () => {
      const result = isPrivateIp("224.0.0.1");
      assert.ok(result.blocked);
    });

    void it("blocks CGNAT 100.64.0.1", () => {
      const result = isPrivateIp("100.64.0.1");
      assert.ok(result.blocked);
    });

    void it("allows public IP 8.8.8.8", () => {
      const result = isPrivateIp("8.8.8.8");
      assert.ok(!result.blocked);
    });

    void it("allows public IP 1.1.1.1", () => {
      const result = isPrivateIp("1.1.1.1");
      assert.ok(!result.blocked);
    });

    void it("blocks IPv6 unique-local and multicast addresses", () => {
      assert.match(isPrivateIp("fd12:3456::1").reason ?? "", /unique-local/);
      assert.match(isPrivateIp("ff02::1").reason ?? "", /multicast/);
    });

    void it("blocks IPv4-mapped IPv6 loopback in dotted and hexadecimal forms", () => {
      assert.ok(isPrivateIp("::ffff:127.0.0.1").blocked);
      assert.ok(isPrivateIp("::ffff:7f00:1").blocked);
    });

    void it("allows a public IPv6 address", () => {
      assert.equal(isPrivateIp("2606:4700:4700::1111").blocked, false);
    });
  });

  void describe("validateHostname", () => {
    void it("blocks metadata.google.internal", () => {
      const result = validateHostname("metadata.google.internal");
      assert.ok(!result.valid);
    });

    void it("allows example.com", () => {
      const result = validateHostname("example.com");
      assert.ok(result.valid);
    });
  });

  void describe("guardUrl", () => {
    void it("passes safe URLs", () => {
      assert.doesNotThrow(() => {
        guardUrl("https://example.com");
      });
      assert.doesNotThrow(() => {
        guardUrl("https://www.example.com/page?q=test");
      });
    });

    void it("blocks private IP in hostname", () => {
      assert.throws(() => {
        guardUrl("http://127.0.0.1:8080/admin");
      }, SsrfError);
    });

    void it("blocks AWS metadata endpoint", () => {
      assert.throws(() => {
        guardUrl("http://169.254.169.254/latest/meta-data/");
      }, SsrfError);
    });

    void it("blocks file:// protocol via URL parsing", () => {
      assert.throws(() => {
        guardUrl("file:///etc/passwd");
      }, SsrfError);
    });

    // Test all SSRF corpus entries
    for (const testCase of SSRF_CORPUS) {
      void it(`SSRF corpus: ${testCase.description}`, () => {
        try {
          guardUrl(testCase.url);
          assert.fail(`Expected SsrfError for "${testCase.description}" (${testCase.url})`);
        } catch (err) {
          if (!(err instanceof SsrfError)) {
            // guardUrl delegates to the SSRF check; if URL parsing fails, it also throws SsrfError
            assert.ok(err instanceof SsrfError, `Got unexpected error: ${(err as Error).message}`);
          }
        }
      });
    }

    // Test all safe URLs pass
    for (const testCase of SAFE_URLS) {
      void it(`safe URL: ${testCase.description}`, () => {
        assert.doesNotThrow(() => {
          guardUrl(testCase.url);
        });
      });
    }
  });
});
