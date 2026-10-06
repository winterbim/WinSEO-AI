import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decryptTotpSecret,
  deriveMfaKey,
  encryptTotpSecret,
  fixtureTotpCode,
  generateTotpSecret,
  matchingTotpCounter,
} from "./totp.ts";

void describe("TOTP seed handling", () => {
  void it("matches RFC 6238 SHA-1 vectors with six digits", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // base32 of 12345678901234567890
    assert.equal(matchingTotpCounter(secret, "287082", 59_000), 1);
    assert.equal(matchingTotpCounter(secret, "081804", 1_111_111_109_000), 37_037_036);
    assert.equal(matchingTotpCounter(secret, "000000", 59_000), null);
    assert.equal(matchingTotpCounter(secret, "287082", 59_000 + 60_000), null);
  });

  void it("encrypts seeds with authenticated encryption and rejects tampering", () => {
    const key = deriveMfaKey("test-only-auth-secret");
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret, key);
    assert.equal(decryptTotpSecret(encrypted, key), secret);
    assert.ok(!encrypted.includes(secret));
    const [version, iv, tag, ciphertext] = encrypted.split(".");
    const changedTag = `${tag?.startsWith("A") ? "B" : "A"}${tag?.slice(1) ?? ""}`;
    assert.throws(() => decryptTotpSecret(`${version}.${iv}.${changedTag}.${ciphertext}`, key));
  });

  void it("fixture codes round-trip only in the active TOTP time window", () => {
    const secret = generateTotpSecret();
    const counter = 58_000_000;
    const code = fixtureTotpCode(secret, counter);
    assert.equal(matchingTotpCounter(secret, code, counter * 30_000), counter);
  });
});
