import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptSecret, deriveGscKey, describeSecret, encryptSecret } from "./crypto.ts";

const REFRESH = "1//0gX-refresh-token-with-real-shape";
const KEY = deriveGscKey("unit-test-master-secret-at-least-32-chars");

void describe("GSC token envelope encryption", () => {
  void it("round-trips a refresh token without exposing it in the payload", () => {
    const payload = encryptSecret(REFRESH, KEY);
    assert.match(payload, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.ok(!payload.includes(REFRESH), "ciphertext must not contain the plaintext token");
    assert.ok(!payload.includes("refresh"), "ciphertext must not leak the token's shape");
    assert.equal(decryptSecret(payload, KEY), REFRESH);
  });

  void it("uses a fresh IV per encryption (identical plaintext ≠ identical ciphertext)", () => {
    const a = encryptSecret(REFRESH, KEY);
    const b = encryptSecret(REFRESH, KEY);
    assert.notEqual(a, b, "same token must not be storable in a recognisable form");
    assert.equal(decryptSecret(a, KEY), REFRESH);
    assert.equal(decryptSecret(b, KEY), REFRESH);
  });

  void it("rejects tampered ciphertext, tag and version", () => {
    const payload = encryptSecret(REFRESH, KEY);
    const [version, iv, tag, data] = payload.split(".") as [string, string, string, string];

    const flipped = data.slice(0, -1) + (data.endsWith("A") ? "B" : "A");
    assert.throws(() => decryptSecret([version, iv, tag, flipped].join("."), KEY), {
      name: "Error",
    });
    assert.throws(() => decryptSecret([version, iv, "A".repeat(tag.length), data].join("."), KEY));
    assert.throws(() => decryptSecret(["v2", iv, tag, data].join("."), KEY));
    assert.throws(() => decryptSecret([version, iv, tag].join("."), KEY));
  });

  void it("refuses a different key (rotation invalidates old envelopes)", () => {
    const payload = encryptSecret(REFRESH, KEY);
    const other = deriveGscKey("a-different-master-secret-of-sufficient-length");
    assert.throws(() => decryptSecret(payload, other));
  });

  void it("domain-separates the derived key from raw AUTH_SECRET", () => {
    const derived = deriveGscKey("same-secret-everywhere");
    assert.equal(derived.length, 32);
    assert.notEqual(derived.toString("hex"), Buffer.from("same-secret-everywhere").toString("hex"));
    // Different labels would be needed to collide; two derivations are stable.
    assert.equal(deriveGscKey("same-secret-everywhere").toString("hex"), derived.toString("hex"));
  });

  void it("fails closed on empty secret or non-32-byte keys", () => {
    assert.throws(() => deriveGscKey(""), /non-empty/);
    assert.throws(() => encryptSecret(REFRESH, randomBytes(16)), /32 bytes/);
    assert.throws(() => decryptSecret("v1.a.b.c", randomBytes(31)), /32 bytes/);
  });

  void it("describes secrets for logs without leaking the value", () => {
    assert.equal(describeSecret(""), "absent");
    const payload = encryptSecret(REFRESH, KEY);
    const described = describeSecret(payload);
    assert.ok(!described.includes(payload), "log description must not repeat the payload");
    assert.match(described, /^present\(len=\d+\)$/);
  });
});
