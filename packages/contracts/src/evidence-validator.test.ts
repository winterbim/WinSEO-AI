import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateFinding,
  validateFindingsBatch,
  type FindingRecord,
} from "./evidence-validator.ts";

// Test fixtures ported from NEXUS tests/test_core.py — evidence_lint patterns

void describe("evidence-validator", () => {
  const validFinding: FindingRecord = {
    id: "F-001",
    claim: "The page /contact has a missing meta description tag",
    classification: "OBSERVED",
    scope: "page:/contact",
    observed_at: "2026-10-01T12:00:00Z",
    confidence: "HIGH",
    gate: "recrawl_rule_absent",
    verdict: "EVIDENCED",
    evidence: ["html-snapshot-contact-abc123"],
    limitations: ["Source HTML only; no browser rendering"],
  };

  void describe("validateFinding", () => {
    void it("passes a valid OBSERVED finding", () => {
      const errors = validateFinding(validFinding, 1);
      assert.deepEqual(errors, []);
    });

    void it("rejects missing required fields", () => {
      const record = { id: "F-001" } as unknown as FindingRecord;
      const errors = validateFinding(record, 1);
      assert.ok(errors.length > 0);
      assert.ok(errors.some((e) => e.field === "claim"));
      assert.ok(errors.some((e) => e.field === "classification"));
      assert.ok(errors.some((e) => e.field === "verdict"));
    });

    void it("rejects HYPOTHESIS as EVIDENCED", () => {
      const record: FindingRecord = {
        ...validFinding,
        classification: "HYPOTHESIS",
        claim: "This page may rank better if we add more content.",
      };
      const errors = validateFinding(record, 2);
      const verdictError = errors.find((e) => e.field === "verdict");
      assert.ok(verdictError);
      assert.ok(verdictError.message.includes("cannot be EVIDENCED"));
    });

    void it("rejects INFERRED as EVIDENCED", () => {
      const record: FindingRecord = {
        ...validFinding,
        classification: "INFERRED",
        claim: "Google likely penalized this page.",
      };
      const errors = validateFinding(record, 3);
      const verdictError = errors.find((e) => e.field === "verdict");
      assert.ok(verdictError);
      assert.ok(verdictError.message.includes("INFERRED"));
    });

    void it("rejects UNKNOWN as EVIDENCED", () => {
      const record: FindingRecord = {
        ...validFinding,
        classification: "UNKNOWN",
        claim: "Something is wrong with this page.",
      };
      const errors = validateFinding(record, 4);
      const verdictError = errors.find((e) => e.field === "verdict");
      assert.ok(verdictError);
    });

    void it("rejects EVIDENCED without evidence", () => {
      const record: FindingRecord = {
        ...validFinding,
        evidence: [],
      };
      const errors = validateFinding(record, 5);
      const evidenceError = errors.find((e) => e.field === "evidence");
      assert.ok(evidenceError);
      assert.ok(evidenceError.message.includes("at least one evidence item"));
    });

    void it("rejects certainty language in INFERRED claims", () => {
      const record: FindingRecord = {
        ...validFinding,
        classification: "INFERRED",
        claim: "This will rank #1 because it's the best page guaranteed.",
      };
      const errors = validateFinding(record, 6);
      const claimError = errors.find((e) => e.field === "claim");
      assert.ok(claimError);
      assert.ok(claimError.message.includes("Certainty language"));
    });

    void it("rejects certainty language in HYPOTHESIS claims", () => {
      const record: FindingRecord = {
        ...validFinding,
        classification: "HYPOTHESIS",
        claim: "Adding this keyword will definitely guarantee visibility.",
      };
      const errors = validateFinding(record, 7);
      const claimError = errors.find((e) => e.field === "claim");
      assert.ok(claimError);
    });

    void it("allows certainty language for OBSERVED findings", () => {
      const record: FindingRecord = {
        ...validFinding,
        classification: "OBSERVED",
        claim: "The canonical tag is always pointing to the wrong URL on line 42.",
      };
      const errors = validateFinding(record, 8);
      // "always" in an OBSERVED context is fine — it's directly observed
      const claimError = errors.find((e) => e.field === "claim");
      assert.ok(!claimError);
    });

    void it("accepts PENDING and BLOCKED verdicts", () => {
      for (const verdict of ["PENDING", "BLOCKED"] as const) {
        const record: FindingRecord = { ...validFinding, verdict, evidence: [] };
        const errors = validateFinding(record, 1);
        // PENDING/BLOCKED without evidence is fine — the feature isn't built yet
        const evidenceError = errors.find((e) => e.field === "evidence");
        assert.ok(!evidenceError);
      }
    });

    void it("rejects invalid classification", () => {
      const record = {
        ...validFinding,
        classification: "MAGICAL_SCORE",
      } as unknown as FindingRecord;
      const errors = validateFinding(record, 1);
      const classError = errors.find((e) => e.field === "classification");
      assert.ok(classError);
    });

    void it("rejects invalid verdict", () => {
      const record = { ...validFinding, verdict: "MAYBE" } as unknown as FindingRecord;
      const errors = validateFinding(record, 1);
      const verdictError = errors.find((e) => e.field === "verdict");
      assert.ok(verdictError);
    });
  });

  void describe("validateFindingsBatch", () => {
    void it("passes a batch of valid findings", () => {
      const result = validateFindingsBatch([validFinding, validFinding]);
      assert.ok(result.passed);
      assert.equal(result.total, 2);
      assert.equal(result.errors.length, 0);
    });

    void it("rejects batch with mixed valid/invalid", () => {
      const bad: FindingRecord = {
        ...validFinding,
        classification: "HYPOTHESIS",
        claim: "This page will definitely rank #1.",
      };
      const result = validateFindingsBatch([validFinding, bad]);
      assert.ok(!result.passed);
      assert.equal(result.total, 2);
      assert.ok(result.errors.length >= 2); // verdict + certainty language
    });
  });
});
