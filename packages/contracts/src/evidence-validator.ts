// ─── Evidence Validator ───
// Ported from NEXUS Search Intelligence v0.1.0 — scripts/evidence_lint.py
// Prevents unsupported certainty from entering client reports.
//
// Rules:
// 1. Required fields: id, claim, classification, scope, observed_at, confidence, gate, verdict, evidence, limitations
// 2. Classification must be: OBSERVED, MEASURED, DOCUMENTED, INFERRED, HYPOTHESIS, UNKNOWN
// 3. Verdict must be: EVIDENCED, INSUFFICIENT, DISPROVEN, PENDING, BLOCKED, WAIVED, SUPERSEDED
// 4. INFERRED, HYPOTHESIS, UNKNOWN cannot be EVIDENCED as factual conclusion
// 5. EVIDENCED requires non-empty evidence[]
// 6. Certainty language prohibited in claims not directly observed/measured/documented

import type { EpistemicClass } from "@serpvera/contracts";

// NEXUS-compatible verdicts (superset of WinSEO gate verdicts)
export type EvidenceVerdict =
  | "EVIDENCED"
  | "INSUFFICIENT"
  | "DISPROVEN"
  | "PENDING"
  | "BLOCKED"
  | "WAIVED"
  | "SUPERSEDED";

export interface FindingRecord {
  id: string;
  claim: string;
  classification: EpistemicClass;
  scope: string;
  observed_at: string;
  confidence: string; // "HIGH" | "MEDIUM" | "LOW"
  gate: string;
  verdict: EvidenceVerdict;
  evidence: string[];
  limitations: string[];
}

/**
 * Untrusted record exactly as it arrives from external JSONL: every field may
 * be absent, mistyped or extra. FindingRecord describes the OUTPUT of a passing
 * validation, never its input — the validator must not trust the shape it is
 * asked to check (tests deliberately feed `{ id: "F-001" }`-shaped records).
 */
export type UntrustedFindingRecord = { [K in keyof FindingRecord]?: unknown };

export interface ValidationError {
  line: number;
  field: string;
  message: string;
}

const VALID_CLASSES = new Set<string>([
  "OBSERVED",
  "MEASURED",
  "DOCUMENTED",
  "INFERRED",
  "HYPOTHESIS",
  "UNKNOWN",
]);

const VALID_VERDICTS = new Set<string>([
  "EVIDENCED",
  "INSUFFICIENT",
  "DISPROVEN",
  "PENDING",
  "BLOCKED",
  "WAIVED",
  "SUPERSEDED",
]);

const REQUIRED_FIELDS = [
  "id",
  "claim",
  "classification",
  "scope",
  "observed_at",
  "confidence",
  "gate",
  "verdict",
  "evidence",
  "limitations",
] as const;

// Certainty language that should not appear in non-direct-measurement claims
const CERTAINTY_PATTERN =
  /\b(guarantee[sd]?|always|definitely|certainly|will rank|will be cited|ranking factor|guaranteed visibility)\b/i;

/**
 * Render an untrusted value for error messages without pretending its type is
 * known: strings pass through unchanged, primitives stringify like template
 * literals would, and only genuinely object-shaped values fall back to JSON.
 */
function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "object") {
    try {
      // JSONL input can only reach here with plain objects/arrays; circular
      // structures would throw, so fall back instead of crashing the report.
      return JSON.stringify(value);
    } catch {
      return "[unserialisable]";
    }
  }
  // Symbols/functions cannot be produced by JSON.parse — stay total anyway.
  return "[unsupported value]";
}

/**
 * Validate a single finding record against evidence doctrine.
 * Returns array of errors (empty = valid).
 */
export function validateFinding(record: UntrustedFindingRecord, line: number): ValidationError[] {
  const errors: ValidationError[] = [];

  // 1. Required fields
  for (const field of REQUIRED_FIELDS) {
    if (!(field in record) || record[field] === undefined || record[field] === null) {
      errors.push({
        line,
        field,
        message: `Missing required field: ${field}`,
      });
    }
  }

  // 2. Classification must be valid
  // String() keeps the exact legacy semantics for non-string runtime values
  // (they are reported as invalid rather than silently skipped).
  if (record.classification && !VALID_CLASSES.has(displayValue(record.classification))) {
    errors.push({
      line,
      field: "classification",
      message: `Invalid classification: ${displayValue(record.classification)}. Must be one of: ${[...VALID_CLASSES].join(", ")}`,
    });
  }

  // 3. Verdict must be valid
  if (record.verdict && !VALID_VERDICTS.has(displayValue(record.verdict))) {
    errors.push({
      line,
      field: "verdict",
      message: `Invalid verdict: ${displayValue(record.verdict)}. Must be one of: ${[...VALID_VERDICTS].join(", ")}`,
    });
  }

  // 4. INFERRED, HYPOTHESIS, UNKNOWN cannot be EVIDENCED
  if (
    typeof record.classification === "string" &&
    ["INFERRED", "HYPOTHESIS", "UNKNOWN"].includes(record.classification) &&
    record.verdict === "EVIDENCED"
  ) {
    errors.push({
      line,
      field: "verdict",
      message: `${record.classification} cannot be EVIDENCED as factual conclusion. Requires direct observation, measurement, or documentation.`,
    });
  }

  // 5. EVIDENCED requires evidence[]
  // Array.isArray also rejects non-array runtime values (e.g. `evidence: 42`),
  // which the old `length === 0` check silently accepted — a real validator gap.
  if (record.verdict === "EVIDENCED" && (!Array.isArray(record.evidence) || record.evidence.length === 0)) {
    errors.push({
      line,
      field: "evidence",
      message: "EVIDENCED verdict requires at least one evidence item.",
    });
  }

  // 6. Certainty language in non-direct claims
  if (
    typeof record.claim === "string" &&
    CERTAINTY_PATTERN.test(record.claim) &&
    typeof record.classification === "string" &&
    !["OBSERVED", "MEASURED", "DOCUMENTED"].includes(record.classification)
  ) {
    errors.push({
      line,
      field: "claim",
      message: "Certainty language detected in claim without direct observation/measurement/documentation.",
    });
  }

  return errors;
}

/**
 * Validate a batch of findings (e.g., JSONL string or parsed array).
 */
export function validateFindingsBatch(records: UntrustedFindingRecord[]): {
  passed: boolean;
  total: number;
  errors: ValidationError[];
} {
  const allErrors: ValidationError[] = [];

  for (const [i, record] of records.entries()) {
    const errors = validateFinding(record, i + 1);
    allErrors.push(...errors);
  }

  return {
    passed: allErrors.length === 0,
    total: records.length,
    errors: allErrors,
  };
}