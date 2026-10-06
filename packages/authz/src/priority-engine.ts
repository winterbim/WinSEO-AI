// ─── Priority Engine ───
// Blueprint §16.2 — ranks actions by business value, evidence, impact, confidence, effort, risk
//
// FORMULA (NEXUS-derived, adapted 2026-10-02):
//   priority = (businessValue × evidenceStrength × impactHypothesis × confidence)
//            / (max(effort, 0.5) × (1 + riskFactor / 5))
//
// This is a workflow heuristic, NOT a search-engine ranking signal.
// Risk is damped per NEXUS convention: (1 + risk/5) prevents division-by-zero
// and smooths extreme risk values. Effort floors at 0.5.
// Source: NEXUS Search Intelligence v0.1.0 — scripts/opportunity_rank.py

import type { ActionState } from "@serpvera/contracts";

export interface PriorityInput {
  businessValue: number;      // 0-10: how much revenue/traffic this affects
  evidenceStrength: number;   // 0-10: quality of evidence behind this finding
  impactHypothesis: number;   // 0-10: expected improvement if fixed
  confidence: number;         // 0-1: how certain we are of the diagnosis
  effort: number;             // 1-10: implementation difficulty
  riskFactor: number;         // 1-10: risk of breaking something
}

export function computePriorityIndex(input: PriorityInput): number {
  const numerator =
    (input.businessValue || 1) *
    (input.evidenceStrength || 1) *
    (input.impactHypothesis || 1) *
    (input.confidence || 0.5);

  // NEXUS-safe denominator: effort floored at 0.5, risk damped as (1 + risk/5)
  const effortFloor = Math.max(input.effort || 0, 0.5);
  const riskDamped = 1 + (input.riskFactor || 0) / 5;
  const denominator = effortFloor * riskDamped;

  return Math.round((numerator / denominator) * 100) / 100;
}

// Explanation of each priority component
export function explainPriority(input: PriorityInput): string[] {
  const lines: string[] = [];

  if (input.businessValue >= 7) lines.push("High business impact: affects key pages or revenue.");
  if (input.evidenceStrength >= 7) lines.push("Strong evidence: multiple data sources confirm.");
  if (input.impactHypothesis >= 7) lines.push("High expected improvement if resolved.");
  if (input.confidence >= 0.8) lines.push("High diagnostic confidence.");
  if (input.effort <= 3) lines.push("Low effort: quick fix possible.");
  if (input.riskFactor <= 3) lines.push("Low risk: safe to implement.");
  if (input.riskFactor >= 7) lines.push("High risk: needs careful testing before production.");

  return lines.length > 0 ? lines : ["Standard priority — no strong signals."];
}

// ─── Action State Machine ───
// Blueprint §17.1
export const ACTION_STATE_TRANSITIONS: Record<ActionState, ActionState[]> = {
  DETECTED: ["EVIDENCED"],
  EVIDENCED: ["PROPOSED", "INCONCLUSIVE"],
  PROPOSED: ["APPROVED"],
  APPROVED: ["REPORTED_MANUALLY"],
  REPORTED_MANUALLY: ["MEASURING"],
  MEASURING: ["VERIFIED", "REJECTED", "INCONCLUSIVE"],
  VERIFIED: ["CLOSED"],
  REJECTED: ["CLOSED"],
  INCONCLUSIVE: ["PROPOSED"],  // re-propose with better evidence
  CLOSED: [],
};

export function isValidTransition(
  from: ActionState,
  to: ActionState,
): boolean {
  // ACTION_STATE_TRANSITIONS is a total Record<ActionState, ...> — indexing it
  // with a valid ActionState can never yield undefined, so no fallback is needed.
  return ACTION_STATE_TRANSITIONS[from].includes(to);
}

export function requireEvidence(state: ActionState): boolean {
  // Actions cannot be reported as manually published without prior evidence.
  return state !== "DETECTED";
}
