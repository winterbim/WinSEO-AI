import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logger } from "@serpvera/telemetry";
import { hashPassword, verifyPassword } from "../auth/crypto.ts";
import {
  issueSession,
  revokeSession,
  clearSessionCookie,
  readCookieToken,
  hashToken,
  requireAuth,
} from "../auth/session.ts";
import { DuplicateEmailError } from "../stores/types.ts";

// Routes receive stores via the Fastify instance decorator (app.stores).
// Production: PostgreSQL-backed (RLS). Tests: in-memory (explicit).
export function authRoutes(app: FastifyInstance) {
  // POST /v1/auth/register
  app.post("/register", async (request, reply) => {
    const schema = z.object({
      email: z.email(),
      password: z.string().min(8),
      name: z.string().optional(),
    });

    const body = schema.parse(request.body);
    const passwordHash = await hashPassword(body.password);

    try {
      const user = await app.stores.users.createUser(
        body.email,
        passwordHash,
        body.name,
      );

      await issueSession(app.stores.sessions, reply, { userId: user.id, email: user.email });
      logger.info("User registered", { userId: user.id });

      return await reply.status(201).send({
        user: { id: user.id, email: user.email, name: user.name },
      });
    } catch (err) {
      if (err instanceof DuplicateEmailError) {
        return reply.status(409).send({
          error: { code: "EMAIL_EXISTS", message: err.message },
        });
      }
      throw err;
    }
  });

  // POST /v1/auth/login
  app.post("/login", async (request, reply) => {
    const schema = z.object({
      email: z.email(),
      password: z.string(),
    });

    const body = schema.parse(request.body);

    const foundUser = await app.stores.users.findByEmail(body.email);
    if (!foundUser) {
      return reply.status(401).send({
        error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." },
      });
    }

    const valid = await verifyPassword(body.password, foundUser.passwordHash);
    if (!valid) {
      return reply.status(401).send({
        error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." },
      });
    }

    await issueSession(app.stores.sessions, reply, {
      userId: foundUser.id,
      email: foundUser.email,
    });
    return reply.send({ user: { id: foundUser.id, email: foundUser.email } });
  });

  // POST /v1/auth/logout
  // Server-side revocation: the session row is invalidated BEFORE the cookie
  // is cleared, so a replayed copy of the cookie is rejected immediately.
  app.post("/logout", async (request, reply) => {
    await revokeSession(app.stores, request, reply);
    return reply.send({ ok: true });
  });

  // POST /v1/auth/logout-all
  // Revokes EVERY session of the authenticated user (device loss /
  // account-compromise response).
  app.post("/logout-all", async (request, reply) => {
    try {
      requireAuth(request, reply);
    } catch {
      return;
    }
    const revoked = await app.stores.sessions.revokeAllForUser(
      request.session.userId,
    );
    clearSessionCookie(reply);
    logger.info("All sessions revoked", {
      userId: request.session.userId,
      revoked,
    });
    return reply.send({ ok: true, revoked });
  });

  // POST /v1/auth/select-organization
  // Activates a tenant context for the session. The organizationId and role are
  // read from the DB membership row — NEVER taken from client-supplied input
  // beyond the org id itself, which is authorisation-checked here. Without this
  // endpoint the session would carry no tenant context and every tenant-scoped
  // route would be unusable (or would have to trust a client-asserted tenant).
  app.post("/select-organization", async (request, reply) => {
    try {
      requireAuth(request, reply);
    } catch {
      return;
    }

    const schema = z.object({ organizationId: z.uuid() });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "INVALID_ID", message: "organizationId must be a UUID." },
      });
    }

    // Membership-gated: returns null unless this user is an ACTIVE member.
    const org = await app.stores.orgs.getForRequester(
      request.session.userId,
      parsed.data.organizationId,
    );
    if (!org) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Organization not found." },
      });
    }

    const role = await app.stores.orgs.getRoleForUser(
      request.session.userId,
      org.id,
    );

    // ROTATION on privilege change: the previous token is revoked server-side
    // and a fresh one is issued carrying the tenant context. The old cookie
    // becomes invalid immediately.
    const oldToken = readCookieToken(request);
    if (oldToken) await app.stores.sessions.revoke(hashToken(oldToken));
    await issueSession(app.stores.sessions, reply, {
      userId: request.session.userId,
      email: request.session.email,
      organizationId: org.id,
      role: role ?? "VIEWER",
    });

    logger.info("Organization selected", {
      userId: request.session.userId,
      organizationId: org.id,
    });

    return reply.send({
      organization: org,
      tenant: { organizationId: org.id, role: role ?? "VIEWER" },
    });
  });

  // GET /v1/auth/me
  app.get("/me", async (request, reply) => {
    try {
      requireAuth(request, reply);
    } catch {
      return;
    }

    const user = await app.stores.users.findById(request.session.userId);
    if (!user) {
      clearSessionCookie(reply);
      return reply.status(401).send({
        error: { code: "USER_NOT_FOUND", message: "User not found." },
      });
    }

    return reply.send({ user: { id: user.id, email: user.email } });
  });
}
