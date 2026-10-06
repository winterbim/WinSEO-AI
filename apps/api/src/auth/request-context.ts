// ─── Request auth context ───
// Canonical helpers for "which tenant am I acting for?" and "may this role do
// this?" so new routes do not hand-roll session checks. Existing route modules
// predate this file and still inline the same logic; they are migrated
// opportunistically, never in the same change as a behaviour edit.

import type { FastifyReply, FastifyRequest } from "fastify";
import { hasPermission } from "@serpvera/authz";
import type { Permission } from "@serpvera/contracts";
import { requireAuth } from "./session.ts";

/**
 * Resolve the active organization for a request.
 *
 * Returns null after already writing the 400/401 reply — callers must return
 * immediately, exactly like the original per-route implementations.
 */
export function activeOrg(request: FastifyRequest, reply: FastifyReply): string | null {
  try {
    requireAuth(request, reply);
  } catch {
    // requireAuth already wrote the 401 reply before throwing.
    return null;
  }
  if (!request.session.organizationId) {
    void reply.status(400).send({
      error: { code: "NO_ACTIVE_ORGANIZATION", message: "Select an organization first." },
    });
    return null;
  }
  return request.session.organizationId;
}

/** 403 unless the session's role carries `permission`. */
export function requirePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  permission: Permission,
): boolean {
  const role = request.session?.role;
  if (!role || !hasPermission(role, permission)) {
    void reply.status(403).send({
      error: { code: "FORBIDDEN", message: `Role cannot perform ${permission}.` },
    });
    return false;
  }
  return true;
}
