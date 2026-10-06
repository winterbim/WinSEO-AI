import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computePriorityIndex,
  explainPriority,
  isValidTransition,
  requireEvidence,
} from "./priority-engine.ts";

void describe("priority-engine", () => {
  void describe("computePriorityIndex", () => {
    void it("high value, low effort = high priority", () => {
      const p = computePriorityIndex({
        businessValue: 8,
        evidenceStrength: 8,
        impactHypothesis: 7,
        confidence: 0.9,
        effort: 2,
        riskFactor: 2,
      });
      assert.ok(p > 50, `Expected high priority, got ${p}`);
    });

    void it("low value, high effort = low priority", () => {
      const p = computePriorityIndex({
        businessValue: 2,
        evidenceStrength: 3,
        impactHypothesis: 2,
        confidence: 0.3,
        effort: 9,
        riskFactor: 8,
      });
      assert.ok(p < 1, `Expected low priority, got ${p}`);
    });

    void it("defaults to minimum 0.5 effort and safe risk denominator", () => {
      // effort=0 floors to 0.5, riskFactor=0 gives (1 + 0/5) = 1
      // so denominator = 0.5 * 1 = 0.5
      // numerator = 5*5*5*0.5 = 62.5
      // score = 62.5 / 0.5 = 125
      const p = computePriorityIndex({
        businessValue: 5,
        evidenceStrength: 5,
        impactHypothesis: 5,
        confidence: 0.5,
        effort: 0,
        riskFactor: 0,
      });
      assert.ok(p > 0, `Expected positive value, got ${p}`);
      assert.ok(isFinite(p), `Expected finite value, got ${p}`);
    });

    void it("handles zero risk safely via damping", () => {
      const p = computePriorityIndex({
        businessValue: 8,
        evidenceStrength: 8,
        impactHypothesis: 8,
        confidence: 0.8,
        effort: 2,
        riskFactor: 0,
      });
      // numerator = 8*8*8*0.8 = 409.6
      // denominator = 2 * (1 + 0/5) = 2
      // score = 204.8
      assert.ok(p > 0);
      assert.ok(isFinite(p));
    });

    void it("high risk reduces priority but never to zero", () => {
      const p = computePriorityIndex({
        businessValue: 10,
        evidenceStrength: 10,
        impactHypothesis: 10,
        confidence: 1.0,
        effort: 1,
        riskFactor: 10,
      });
      // denominator = 1 * (1+10/5) = 3
      // numerator = 1000
      // score = 333.33
      assert.ok(p > 100);
      assert.ok(isFinite(p));
    });
  });

  void describe("explainPriority", () => {
    void it("returns explanations for strong signals", () => {
      const lines = explainPriority({
        businessValue: 9,
        evidenceStrength: 8,
        impactHypothesis: 2,
        confidence: 0.9,
        effort: 2,
        riskFactor: 8,
      });
      assert.ok(lines.some((l) => l.includes("business impact")));
      assert.ok(lines.some((l) => l.includes("evidence")));
      assert.ok(lines.some((l) => l.includes("confidence")));
      assert.ok(lines.some((l) => l.includes("effort")));
      assert.ok(lines.some((l) => l.includes("risk")));
    });
  });

  void describe("isValidTransition", () => {
    void it("DETECTED → EVIDENCED is valid", () => {
      assert.ok(isValidTransition("DETECTED", "EVIDENCED"));
    });

    void it("DETECTED → REPORTED_MANUALLY is invalid (must go through EVIDENCED)", () => {
      assert.ok(!isValidTransition("DETECTED", "REPORTED_MANUALLY"));
    });

    void it("MEASURING → VERIFIED is valid", () => {
      assert.ok(isValidTransition("MEASURING", "VERIFIED"));
    });

    void it("MEASURING → INCONCLUSIVE is valid", () => {
      assert.ok(isValidTransition("MEASURING", "INCONCLUSIVE"));
    });

    void it("INCONCLUSIVE → PROPOSED allows re-proposal", () => {
      assert.ok(isValidTransition("INCONCLUSIVE", "PROPOSED"));
    });
  });

  void describe("requireEvidence", () => {
    void it("DETECTED is not evidenced yet", () => {
      assert.ok(!requireEvidence("DETECTED"));
    });

    void it("EVIDENCED and beyond require evidence", () => {
      assert.ok(requireEvidence("EVIDENCED"));
      assert.ok(requireEvidence("PROPOSED"));
      assert.ok(requireEvidence("REPORTED_MANUALLY"));
    });
  });
});
