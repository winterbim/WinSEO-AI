import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasPermission, requirePermission, canManageRole, AuthorizationError } from "./index.ts";

void describe("authz", () => {
  void describe("hasPermission", () => {
    void it("OWNER has all permissions", () => {
      assert.ok(hasPermission("OWNER", "project.read"));
      assert.ok(hasPermission("OWNER", "evidence.write"));
      assert.ok(hasPermission("OWNER", "production.write"));
      assert.ok(hasPermission("OWNER", "billing.manage"));
    });

    void it("VIEWER only has read permissions", () => {
      assert.ok(hasPermission("VIEWER", "project.read"));
      assert.ok(hasPermission("VIEWER", "evidence.read"));
      assert.ok(!hasPermission("VIEWER", "evidence.write"));
      assert.ok(!hasPermission("VIEWER", "production.write"));
      assert.ok(!hasPermission("VIEWER", "billing.manage"));
    });

    void it("EDITOR has production.write but not billing.manage", () => {
      assert.ok(hasPermission("EDITOR", "production.write"));
      assert.ok(hasPermission("EDITOR", "evidence.write"));
      assert.ok(!hasPermission("EDITOR", "billing.manage"));
    });

    void it("BILLING can read project evidence but cannot add evidence", () => {
      assert.ok(hasPermission("BILLING", "evidence.read"));
      assert.ok(!hasPermission("BILLING", "evidence.write"));
    });

    void it("production.write is separate from action.approve", () => {
      // ANALYST can approve but NOT write to production
      assert.ok(hasPermission("ANALYST", "action.approve"));
      assert.ok(!hasPermission("ANALYST", "production.write"));
      // BILLING can neither approve nor write
      assert.ok(!hasPermission("BILLING", "action.approve"));
      assert.ok(!hasPermission("BILLING", "production.write"));
    });
  });

  void describe("requirePermission", () => {
    void it("throws AuthorizationError when permission denied", () => {
      assert.throws(() => {
        requirePermission("VIEWER", "production.write");
      }, AuthorizationError);
    });

    void it("does not throw when permission granted", () => {
      assert.doesNotThrow(() => {
        requirePermission("ADMIN", "production.write");
      });
    });
  });

  void describe("canManageRole", () => {
    void it("OWNER can manage ADMIN", () => {
      assert.ok(canManageRole("OWNER", "ADMIN"));
    });

    void it("ADMIN cannot manage OWNER", () => {
      assert.ok(!canManageRole("ADMIN", "OWNER"));
    });

    void it("VIEWER cannot manage anyone", () => {
      assert.ok(!canManageRole("VIEWER", "ANALYST"));
      assert.ok(!canManageRole("VIEWER", "EDITOR"));
      assert.ok(!canManageRole("VIEWER", "VIEWER"));
    });

    void it("ADMIN cannot manage another ADMIN", () => {
      assert.ok(!canManageRole("ADMIN", "ADMIN"));
    });
  });
});
