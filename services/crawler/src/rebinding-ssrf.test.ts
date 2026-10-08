import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { createHttpFetcher, createPinnedLookup, createResponseDecoder } from "./http-fetcher.ts";
import { normalizeUrl } from "./url-normalizer.ts";
import { guardUrl, SsrfError } from "./ssrf-guard.ts";

// ─── Connection-time SSRF defence (pre-connect validation) ───
//
// These tests cover fail-closed DNS validation and the connection lookup pin.
// The HTTP transport is not sent to the public internet in tests. Full redirect
// integration against a routable local fixture remains separate from this unit
// coverage; every redirect still passes guardUrl and a fresh DNS validation.

const PUBLIC_NAME = "public-fixture.example";
const PUBLIC_IP = "93.184.216.34"; // example.com's historical A record

void describe("http-fetcher connection-time SSRF defence", () => {
  void it("pre-flight guard accepts a plain public hostname (control)", () => {
    // Control: proves the name itself is not blocked, so a later rejection must
    // come from resolution — not from the name check.
    assert.doesNotThrow(() => {
      guardUrl(`https://${PUBLIC_NAME}/`);
    });
  });

  void it("blocks a public-looking name that resolves to the AWS metadata IP (rebinding)", async () => {
    let dnsCalls = 0;
    const fetcher = createHttpFetcher({
      traceId: "rebind-metadata",
      timeoutMs: 3000,
      resolve: () => {
        dnsCalls++;
        return Promise.resolve(["169.254.169.254"]); // link-local: cloud metadata endpoint
      },
    });

    const res = await fetcher.fetchPage(normalizeUrl(`https://${PUBLIC_NAME}/`));

    assert.equal(res.body, null, "no body may be returned");
    assert.ok(res.error, "must fail");
    assert.match(res.error, /SSRF blocked/i);
    assert.match(res.error, /link-local|169\.254/i);
    assert.ok(dnsCalls >= 1, "resolution must have been attempted before refusal");
  });

  void it("blocks a name that resolves to an RFC1918 address", async () => {
    const fetcher = createHttpFetcher({
      traceId: "rebind-rfc1918",
      timeoutMs: 3000,
      resolve: () => Promise.resolve(["10.0.0.5"]),
    });
    const res = await fetcher.fetchPage(normalizeUrl(`https://${PUBLIC_NAME}/`));
    assert.ok(res.error);
    assert.match(res.error, /SSRF blocked/i);
    assert.match(res.error, /10\.0\.0\.0\/8/);
    assert.equal(res.body, null);
  });

  void it("blocks a name that resolves to loopback", async () => {
    const fetcher = createHttpFetcher({
      traceId: "rebind-loopback",
      timeoutMs: 3000,
      resolve: () => Promise.resolve(["127.0.0.1"]),
    });
    const res = await fetcher.fetchPage(normalizeUrl(`https://${PUBLIC_NAME}/`));
    assert.ok(res.error);
    assert.match(res.error, /SSRF blocked/i);
    assert.equal(res.body, null);
  });

  void it("fails closed when DNS returns no addresses", async () => {
    const fetcher = createHttpFetcher({
      traceId: "no-dns",
      timeoutMs: 3000,
      resolve: () => Promise.resolve([]),
    });
    const res = await fetcher.fetchPage(normalizeUrl(`https://${PUBLIC_NAME}/`));
    assert.ok(res.error, "must fail rather than proceed");
    assert.match(res.error, /No IP addresses resolved/);
    assert.equal(res.body, null);
  });

  void it("pins both Node lookup callback forms to the validated IP", () => {
    const lookup = createPinnedLookup(PUBLIC_NAME, PUBLIC_IP);
    lookup(PUBLIC_NAME, { all: false }, (error, address, family) => {
      assert.ifError(error);
      assert.equal(address, PUBLIC_IP);
      assert.equal(family, 4);
    });
    lookup(PUBLIC_NAME, { all: true }, (error, addresses) => {
      assert.ifError(error);
      assert.deepEqual(addresses, [{ address: PUBLIC_IP, family: 4 }]);
    });
    lookup("unexpected.example", { all: false }, (error) => {
      assert.equal(error?.code, "EHOSTUNREACH");
    });
  });

  void it("decodes bounded HTTP response encodings supported by the transport", async () => {
    const input = Buffer.from("<title>Fixture</title>");
    const cases = [
      ["gzip", gzipSync(input)],
      ["deflate", deflateSync(input)],
      ["br", brotliCompressSync(input)],
    ] as const;

    for (const [encoding, compressed] of cases) {
      const decoder = createResponseDecoder(encoding);
      assert.ok(decoder);
      const output = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        decoder.on("data", (chunk: Buffer) => chunks.push(chunk));
        decoder.on("end", () => {
          resolve(Buffer.concat(chunks));
        });
        decoder.on("error", reject);
        decoder.end(compressed);
      });
      assert.deepEqual(output, input);
    }

    assert.equal(createResponseDecoder("identity"), null);
    assert.throws(() => createResponseDecoder("zstd"), /Unsupported content encoding/);
  });

  void it("rejects a mixed public/private DNS answer before transport", async () => {
    let fetchCalls = 0;
    const fetcher = createHttpFetcher({
      traceId: "mixed-dns",
      timeoutMs: 3000,
      resolve: () => Promise.resolve([PUBLIC_IP, "127.0.0.1"]),
      fetchImpl: () => {
        fetchCalls++;
        return Promise.resolve(new Response("unexpected network access"));
      },
    });
    const res = await fetcher.fetchPage(normalizeUrl(`https://${PUBLIC_NAME}/`));
    assert.match(res.error ?? "", /SSRF blocked/i);
    assert.match(res.error ?? "", /127\.0\.0\.1/);
    assert.equal(res.body, null);
    assert.equal(fetchCalls, 0, "private DNS answer must be rejected before transport");
  });

  void it("bounds DNS resolution by the per-request timeout before transport", async () => {
    let fetchCalls = 0;
    const fetcher = createHttpFetcher({
      traceId: "dns-timeout",
      timeoutMs: 3_000,
      resolve: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve([PUBLIC_IP]);
          }, 100);
        }),
      fetchImpl: () => {
        fetchCalls++;
        return Promise.resolve(new Response("unexpected network access"));
      },
    });

    const result = await fetcher.fetchPage(normalizeUrl(`https://${PUBLIC_NAME}/`), {
      timeoutMs: 20,
    });

    assert.match(result.error ?? "", /timed out|timeout/i);
    assert.equal(fetchCalls, 0, "a timed-out DNS lookup must never reach the transport");
  });

  void it("refuses an out-of-origin redirect before making the second request", async () => {
    const requests: string[] = [];
    const fetcher = createHttpFetcher({
      traceId: "crawl-scope-redirect",
      resolve: () => Promise.resolve([PUBLIC_IP]),
      allowRedirect: (_from, to) => new URL(to).origin === `https://${PUBLIC_NAME}`,
      fetchImpl: (input) => {
        requests.push(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://other.example/private" },
          }),
        );
      },
    });

    const result = await fetcher.fetchPage(normalizeUrl(`https://${PUBLIC_NAME}/`));

    assert.match(result.error ?? "", /scope policy/i);
    assert.equal(result.httpStatus, 302);
    assert.deepEqual(requests, [`https://${PUBLIC_NAME}/`]);
  });

  void it("runs the per-hop policy hook before issuing a redirected request", async () => {
    const events: string[] = [];
    const fetcher = createHttpFetcher({
      traceId: "redirect-hop-hook",
      resolve: () => Promise.resolve([PUBLIC_IP]),
      allowRedirect: (_from, to) => new URL(to).origin === `https://${PUBLIC_NAME}`,
      beforeRedirect: async () => {
        events.push("before-redirect");
        await Promise.resolve();
        events.push("redirect-ready");
      },
      fetchImpl: (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        events.push(`request:${new URL(url).pathname}`);
        if (new URL(url).pathname === "/") {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: "/final" },
            }),
          );
        }
        return Promise.resolve(new Response("final body"));
      },
    });

    const result = await fetcher.fetchPage(normalizeUrl(`https://${PUBLIC_NAME}/`));

    assert.equal(result.body, "final body");
    assert.deepEqual(events, ["request:/", "before-redirect", "redirect-ready", "request:/final"]);
  });

  void it("guardUrl still rejects a private IP literal outright (no DNS needed)", () => {
    assert.throws(() => {
      guardUrl("http://127.0.0.1/");
    }, SsrfError);
    assert.throws(() => {
      guardUrl("http://169.254.169.254/");
    }, SsrfError);
  });
});
