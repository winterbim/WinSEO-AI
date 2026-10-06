// ─── Server-side sessions (P-GAP-05) ───
//
// The cookie carries ONLY an opaque random token (43-char base64url). The server
// holds every byte of session state in the `sessions` store (PostgreSQL in
// production, memory in tests), addressed by SHA-256(token) — the raw token is
// never stored, so a database read cannot be replayed as a cookie.
//
// This makes the security properties REAL rather than client-authoritative:
//   - logout = server-side revocation (the cookie becomes invalid immediately),
//   - logout-all revokes every session of a user,
//   - expiry is enforced server-side,
//   - rotating the token (privilege change) invalidates the previous cookie.
//
// Authorization semantics are UNCHANGED: a session only ever carries data the
// SERVER put there, every tenant-scoped route re-verifies membership, and
// PostgreSQL RLS is the final boundary (Blueprint §19.1).

import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { OrgRole } from "@serpvera/contracts";
import type { SessionStore, ApiStores } from "../stores/types.ts";

// ─── Session types ───
export interface Session {
  userId: string;
  email: string;
  organizationId?: string;
  role?: OrgRole;
  stepUpVerifiedAt?: string;
  stepUpMfaCounter?: number;
}

export interface TenantContext {
  organizationId: string;
  userId: string;
  role: NonNullable<Session["role"]>;
}

/** Session lifetime. Renewed on login and on org selection (rotation). */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = "serpvera_session";

/** SHA-256 hex of the opaque token — the only form ever persisted. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Generate a fresh opaque session token (256 bits of entropy). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Create a server-side session and set the cookie.
 * Returns the opaque token (only ever seen by the client in the cookie).
 */
export async function issueSession(
  store: SessionStore,
  reply: FastifyReply,
  session: Session,
): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await store.create(
    hashToken(token),
    session.userId,
    session.email,
    expiresAt,
    session.organizationId,
    session.role,
  );
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  void reply.header(
    "set-cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`,
  );
  return token;
}

/** Extract the opaque token from a request's cookie header. */
export function readCookieToken(request: FastifyRequest): string | null {
  const header = request.raw.headers.cookie;
  if (typeof header !== "string") return null;
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(header);
  return m?.[1] ?? null;
}

/**
 * Resolve a raw cookie token to a Session.
 * Returns null for unknown, revoked, expired, or malformed tokens —
 * all four collapse to "not authenticated".
 */
export async function verifySession(
  store: SessionStore,
  rawToken: string | null,
): Promise<Session | null> {
  if (!rawToken) return null;
  const record = await store.get(hashToken(rawToken));
  if (!record) return null;
  const session: Session = { userId: record.userId, email: record.email };
  if (record.organizationId) session.organizationId = record.organizationId;
  if (record.role) session.role = record.role;
  if (record.stepUpVerifiedAt) session.stepUpVerifiedAt = record.stepUpVerifiedAt;
  if (record.stepUpMfaCounter !== undefined) session.stepUpMfaCounter = record.stepUpMfaCounter;
  return session;
}

/**
 * Server-side logout: revoke the presented token, then clear the cookie.
 * A replayed copy of the cookie is rejected from this moment on.
 */
export async function revokeSession(
  stores: ApiStores,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = readCookieToken(request);
  if (token) await stores.sessions.revoke(hashToken(token));
  clearSessionCookie(reply);
}

/** Clear the cookie without touching server state (e.g. user deleted). */
export function clearSessionCookie(reply: FastifyReply): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  void reply.header(
    "set-cookie",
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
  );
}

// ─── Require auth helper ───
export function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): asserts request is FastifyRequest & { session: Session } {
  if (!request.session) {
    reply.status(401).send({
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    });
    throw Object.assign(new Error("UNAUTHORIZED"), { statusCode: 401 });
  }
}
