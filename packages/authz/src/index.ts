import type { OrgRole, Permission } from "@serpvera/contracts";

// ─── Role → Permissions map ───
export const ROLE_PERMISSIONS: Record<OrgRole, Permission[]> = {
  OWNER: [
    "project.read",
    "evidence.read",
    "integration.manage",
    "action.approve",
    "production.write",
    "billing.manage",
    "member.manage",
  ],
  ADMIN: [
    "project.read",
    "evidence.read",
    "integration.manage",
    "action.approve",
    "production.write",
    "member.manage",
  ],
  ANALYST: ["project.read", "evidence.read", "action.approve"],
  EDITOR: ["project.read", "evidence.read", "action.approve", "production.write"],
  VIEWER: ["project.read", "evidence.read"],
  BILLING: ["project.read", "evidence.read", "billing.manage"],
};

/**
 * Check if a role can perform a given permission.
 */
export function hasPermission(role: OrgRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Assert a role has permission. Throws if not.
 */
export function requirePermission(role: OrgRole, permission: Permission): void {
  if (!hasPermission(role, permission)) {
    throw new AuthorizationError(`Role ${role} lacks permission ${permission}`);
  }
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/**
 * Determine if a role outranks another role.
 * Used for member management: only higher-ranked roles can modify lower-ranked roles.
 */
const ROLE_RANK: Record<OrgRole, number> = {
  OWNER: 100,
  ADMIN: 80,
  ANALYST: 50,
  EDITOR: 40,
  VIEWER: 20,
  BILLING: 60,
};

export function getRoleRank(role: OrgRole): number {
  return ROLE_RANK[role];
}

export function canManageRole(actorRole: OrgRole, targetRole: OrgRole): boolean {
  return getRoleRank(actorRole) > getRoleRank(targetRole);
}