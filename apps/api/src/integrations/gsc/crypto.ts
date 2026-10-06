// ─── GSC token envelope encryption ───
// Google refresh/access tokens are secrets with a long blast radius: a leaked
// refresh token yields continuous read access to a customer's Search Console
// data. They are therefore never stored in plaintext, never returned by the
// API, and never logged — only this ciphertext form reaches the database.
//
// AES-256-GCM gives confidentiality + integrity in one pass: a flipped bit in
// the ciphertext or tag makes decryption throw, so a tampered row cannot be
// replayed as a valid token.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard nonce size
const TAG_BYTES = 16;
const PAYLOAD_VERSION = "v1";

/**
 * Derive the 32-byte envelope key from a deployment master secret.
 *
 * HKDF with a fixed salt + info label domain-separates this key from
 * AUTH_SECRET's other uses (session signing, CSRF), so token encryption can be
 * rotated independently via GSC_TOKEN_KEY without touching sessions.
 */
export function deriveGscKey(masterSecret: string): Buffer {
  if (!masterSecret) throw new Error("GSC token encryption requires a non-empty master secret.");
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(masterSecret, "utf8"), "serpvera-gsc-token-v1", ALGO, 32),
  );
}

/** Encrypt `plaintext` → `v1.<iv>.<tag>.<ciphertext>` (base64url, no padding). */
export function encryptSecret(plaintext: string, key: Buffer): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PAYLOAD_VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(
    ".",
  );
}

/** Decrypt a payload produced by {@link encryptSecret}; throws on any tampering. */
export function decryptSecret(payload: string, key: Buffer): string {
  assertKey(key);
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== PAYLOAD_VERSION) {
    throw new Error("Unsupported GSC token envelope format.");
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("Malformed GSC token envelope.");
  }
  const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  // GCM authentication failure surfaces as a throw — a tampered token row is
  // rejected rather than decoded into attacker-controlled text.
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
}

/**
 * Shape-safe description of a secret for structured logs: never the value, only
 * its presence and a non-reversible fingerprint that lets an operator correlate
 * two log lines about the same token across a rotation.
 */
export function describeSecret(payload: string): string {
  if (!payload) return "absent";
  return `present(len=${payload.length})`;
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) {
    throw new Error(`GSC envelope key must be 32 bytes, received ${key.length}.`);
  }
}
