import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ALGORITHM = "aes-256-gcm";
const STEP_SECONDS = 30;
const DIGITS = 6;
const ENVELOPE = "m1";

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function totpProvisioningUri(secret: string, email: string): string {
  const issuer = "SERPVERA";
  const label = `${issuer}:${email}`;
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

export function deriveMfaKey(masterSecret: string): Buffer {
  if (!masterSecret) throw new Error("MFA encryption requires a non-empty master secret.");
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(masterSecret, "utf8"), "serpvera-mfa-seed-v1", ALGORITHM, 32),
  );
}

export function encryptTotpSecret(secret: string, key: Buffer): string {
  assertKey(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [
    ENVELOPE,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptTotpSecret(envelope: string, key: Buffer): string {
  assertKey(key);
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE) throw new Error("Malformed MFA seed envelope.");
  const [, ivPart, tagPart, ciphertextPart] = parts as [string, string, string, string];
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  const ciphertext = Buffer.from(ciphertextPart, "base64url");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("Malformed MFA seed envelope.");
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Returns the matching TOTP counter in a ±1 step window; callers must consume it atomically. */
export function matchingTotpCounter(
  secret: string,
  code: string,
  nowMs = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(nowMs / 1000 / STEP_SECONDS);
  for (const counter of [current - 1, current, current + 1]) {
    if (counter < 0) continue;
    const expected = hotp(secret, counter);
    const suppliedBytes = Buffer.from(code, "ascii");
    const expectedBytes = Buffer.from(expected, "ascii");
    if (timingSafeEqual(suppliedBytes, expectedBytes)) return counter;
  }
  return null;
}

/** Test helper for RFC 6238 and route fixtures. Never available in production. */
export function fixtureTotpCode(secret: string, counter: number): string {
  if (process.env.NODE_ENV === "production")
    throw new Error("TOTP fixture code generation is disabled in production.");
  return hotp(secret, counter);
}

function hotp(secret: string, counter: number): string {
  const data = Buffer.alloc(8);
  data.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", decodeBase32(secret)).update(data).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

function encodeBase32(bytes: Buffer): string {
  let buffer = 0;
  let bits = 0;
  let output = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output = output.concat(BASE32[(buffer >>> (bits - 5)) & 31] ?? "");
      bits -= 5;
    }
  }
  if (bits > 0) output = output.concat(BASE32[(buffer << (5 - bits)) & 31] ?? "");
  return output;
}

function decodeBase32(value: string): Buffer {
  if (!/^[A-Z2-7]+$/.test(value)) throw new Error("Invalid TOTP seed.");
  let buffer = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const char of value) {
    const digit = BASE32.indexOf(char);
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error("MFA encryption key must contain exactly 32 bytes.");
}
