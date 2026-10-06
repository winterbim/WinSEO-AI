import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { loadConfig } from "@serpvera/config";
import { clearSessionCookie, hashToken, readCookieToken, requireAuth } from "../auth/session.ts";
import { verifyPassword } from "../auth/crypto.ts";
import {
  decryptTotpSecret,
  deriveMfaKey,
  encryptTotpSecret,
  generateTotpSecret,
  matchingTotpCounter,
  totpProvisioningUri,
} from "../auth/totp.ts";

const config = loadConfig();
const mfaKey = deriveMfaKey(config.mfaSecretKey);
const ATTEMPT_LIMIT = 8;

function requireMfaAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): request is FastifyRequest & { session: NonNullable<FastifyRequest["session"]> } {
  try {
    requireAuth(request, reply);
    return true;
  } catch {
    return false;
  }
}

async function rateLimitAttempt(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const decision = await app.stores.rateLimits.hit(request.ip, ATTEMPT_LIMIT);
  if (decision.allowed) return true;
  void reply.header("retry-after", String(decision.retryAfterSeconds));
  void reply.status(429).send({
    error: {
      code: "MFA_RATE_LIMITED",
      message: "Too many authenticator attempts. Try again later.",
    },
  });
  return false;
}

async function currentUserPasswordValid(
  app: FastifyInstance,
  userId: string,
  email: string,
  password: string,
): Promise<boolean> {
  const user = await app.stores.users.findByEmail(email);
  if (user?.id !== userId) return false;
  if (!user.passwordHash) return false;
  return await verifyPassword(password, user.passwordHash);
}

export function mfaRoutes(app: FastifyInstance) {
  app.get("/status", async (request, reply) => {
    if (!requireMfaAuth(request, reply)) return;
    const record = await app.stores.mfa.get(request.session.userId);
    return reply.send({ enabled: Boolean(record?.enabledAt) });
  });

  app.post("/enroll", async (request, reply) => {
    if (!requireMfaAuth(request, reply)) return;
    const body = z.object({ password: z.string().min(1).max(256) }).parse(request.body);
    if (!(await rateLimitAttempt(app, request, reply))) return;
    if (
      !(await currentUserPasswordValid(
        app,
        request.session.userId,
        request.session.email,
        body.password,
      ))
    ) {
      return reply
        .status(401)
        .send({ error: { code: "INVALID_CREDENTIALS", message: "Password verification failed." } });
    }
    const existing = await app.stores.mfa.get(request.session.userId);
    if (existing?.enabledAt) {
      return reply.status(409).send({
        error: { code: "MFA_ALREADY_ENABLED", message: "Authenticator is already enabled." },
      });
    }

    const secret = generateTotpSecret();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const stored = await app.stores.mfa.beginEnrollment(
      request.session.userId,
      encryptTotpSecret(secret, mfaKey),
      expiresAt,
    );
    if (!stored) {
      return reply.status(409).send({
        error: { code: "MFA_ALREADY_ENABLED", message: "Authenticator is already enabled." },
      });
    }
    return reply.send({
      secret,
      provisioningUri: totpProvisioningUri(secret, request.session.email),
      expiresAt,
    });
  });

  app.post("/confirm-enrollment", async (request, reply) => {
    if (!requireMfaAuth(request, reply)) return;
    const body = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(request.body);
    if (!(await rateLimitAttempt(app, request, reply))) return;
    const record = await app.stores.mfa.get(request.session.userId);
    if (
      !record?.encryptedSecret ||
      record.enabledAt ||
      !record.enrollmentExpiresAt ||
      Date.parse(record.enrollmentExpiresAt) <= Date.now()
    ) {
      return reply.status(409).send({
        error: {
          code: "MFA_ENROLLMENT_EXPIRED",
          message: "Start a new authenticator enrollment.",
        },
      });
    }
    const secret = decryptTotpSecret(record.encryptedSecret, mfaKey);
    const counter = matchingTotpCounter(secret, body.code);
    if (
      counter === null ||
      !(await app.stores.mfa.confirmEnrollment(request.session.userId, counter))
    ) {
      return reply.status(401).send({
        error: {
          code: "INVALID_MFA_CODE",
          message: "Authenticator code is invalid or already used.",
        },
      });
    }
    return reply.send({ enabled: true });
  });

  app.post("/disable", async (request, reply) => {
    if (!requireMfaAuth(request, reply)) return;
    const body = z
      .object({ password: z.string().min(1).max(256), code: z.string().regex(/^\d{6}$/) })
      .parse(request.body);
    if (!(await rateLimitAttempt(app, request, reply))) return;
    if (
      !(await currentUserPasswordValid(
        app,
        request.session.userId,
        request.session.email,
        body.password,
      ))
    ) {
      return reply
        .status(401)
        .send({ error: { code: "INVALID_CREDENTIALS", message: "Password verification failed." } });
    }
    const record = await app.stores.mfa.get(request.session.userId);
    if (!record?.encryptedSecret || !record.enabledAt) {
      return reply
        .status(409)
        .send({ error: { code: "MFA_NOT_ENABLED", message: "Authenticator is not enabled." } });
    }
    const secret = decryptTotpSecret(record.encryptedSecret, mfaKey);
    const counter = matchingTotpCounter(secret, body.code);
    if (counter === null || !(await app.stores.mfa.disable(request.session.userId, counter))) {
      return reply.status(401).send({
        error: {
          code: "INVALID_MFA_CODE",
          message: "Authenticator code is invalid or already used.",
        },
      });
    }
    await app.stores.sessions.revokeAllForUser(request.session.userId);
    clearSessionCookie(reply);
    return reply.send({ enabled: false, signedOut: true });
  });
}

export async function consumeStepUpCode(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  code: string,
): Promise<{ counter: number; verifiedAt: string } | null> {
  if (!(await rateLimitAttempt(app, request, reply))) return null;
  const record = await app.stores.mfa.get(userId);
  if (!record?.encryptedSecret || !record.enabledAt) {
    void reply.status(403).send({
      error: {
        code: "MFA_REQUIRED",
        message: "Enable an authenticator before confirming a simulated deployment.",
      },
    });
    return null;
  }
  const secret = decryptTotpSecret(record.encryptedSecret, mfaKey);
  const counter = matchingTotpCounter(secret, code);
  if (counter === null) {
    void reply.status(401).send({
      error: {
        code: "INVALID_MFA_CODE",
        message: "Authenticator code is invalid or already used.",
      },
    });
    return null;
  }
  const existingStepUpAt = request.session?.stepUpVerifiedAt;
  const existingCounter = request.session?.stepUpMfaCounter;
  const existingTimestamp = existingStepUpAt ? Date.parse(existingStepUpAt) : Number.NaN;
  const now = Date.now();
  if (
    existingStepUpAt &&
    existingCounter === counter &&
    Number.isFinite(existingTimestamp) &&
    existingTimestamp <= now &&
    now - existingTimestamp <= 5 * 60_000
  ) {
    return { counter, verifiedAt: existingStepUpAt };
  }
  if (!(await app.stores.mfa.consumeCounter(userId, counter))) {
    void reply.status(401).send({
      error: {
        code: "INVALID_MFA_CODE",
        message: "Authenticator code is invalid or already used.",
      },
    });
    return null;
  }
  const verifiedAt = new Date(now).toISOString();
  const token = readCookieToken(request);
  if (token) {
    await app.stores.sessions.setStepUp(hashToken(token), verifiedAt, counter);
  }
  if (request.session) {
    request.session.stepUpVerifiedAt = verifiedAt;
    request.session.stepUpMfaCounter = counter;
  }
  return { counter, verifiedAt };
}
