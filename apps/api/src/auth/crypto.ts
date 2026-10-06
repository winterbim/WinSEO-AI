import { randomUUID, createHash, randomBytes, scrypt } from "node:crypto";

// ─── Simple password hashing (scrypt) ───
// In production, use a dedicated auth library. This is the MVP implementation.

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = await hashWithSalt(password, salt);
  return `${salt}:${hash}`;
}

function hashWithSalt(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey.toString("hex"));
    });
  });
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const computed = await hashWithSalt(password, salt);
  return timingSafeEqual(hash, computed);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ─── Session tokens ───
export function generateSessionToken(): string {
  return randomUUID() + "." + randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ─── Magic link tokens ───
export function generateMagicToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashMagicToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ─── CSRF tokens ───
export function generateCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}