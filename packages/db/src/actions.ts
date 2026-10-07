import type { ActionState } from "@serpvera/contracts";
import { withTenant } from "./client.ts";
import { publicEvidenceMetadata } from "./evidence-metadata.ts";

const TRANSITIONS: Record<ActionState, readonly ActionState[]> = {
  DETECTED: ["EVIDENCED"],
  EVIDENCED: ["PROPOSED"],
  PROPOSED: ["APPROVED"],
  APPROVED: ["REPORTED_MANUALLY"],
  REPORTED_MANUALLY: ["MEASURING"],
  MEASURING: ["VERIFIED", "REJECTED", "INCONCLUSIVE"],
  VERIFIED: ["CLOSED"],
  REJECTED: ["CLOSED"],
  INCONCLUSIVE: ["PROPOSED"],
  CLOSED: [],
};

export class ActionMutationError extends Error {
  readonly code:
    | "ACTION_NOT_FOUND"
    | "VERSION_CONFLICT"
    | "INVALID_TRANSITION"
    | "EVIDENCE_REQUIRED"
    | "RECOMMENDATION_REQUIRED"
    | "APPROVAL_REQUIRED"
    | "IMPLEMENTATION_REQUIRED"
    | "MEASUREMENT_REQUIRED"
    | "GATE_VERDICT_MISMATCH";

  constructor(
    code:
      | "ACTION_NOT_FOUND"
      | "VERSION_CONFLICT"
      | "INVALID_TRANSITION"
      | "EVIDENCE_REQUIRED"
      | "RECOMMENDATION_REQUIRED"
      | "APPROVAL_REQUIRED"
      | "IMPLEMENTATION_REQUIRED"
      | "MEASUREMENT_REQUIRED"
      | "GATE_VERDICT_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "ActionMutationError";
    this.code = code;
  }
}

export interface ActionTransitionInput {
  expectedVersion: number;
  toState: ActionState | "EVALUATE" | "REJECT_PROPOSAL";
  recommendation?: {
    summary: string;
    rationale?: string;
    verificationGate: { type: string; spec?: Record<string, unknown> };
  };
  approvalDecision?: "APPROVE" | "REJECT";
  implementation?: { whatChanged: string; how: string; references?: string[] };
  rollback?: { strategy: string; trigger?: string; references?: string[] };
  baselineSnapshot?: Record<string, unknown>;
  comparisonWindow?: { startsAt: string; endsAt: string };
  note?: string;
}

export interface ActionActor {
  userId: string;
  email: string;
}

export interface ActionEvidenceRow {
  id: string;
  kind: string;
  sourceRef: string;
  contentHash: string;
  objectKey: string;
  capturedAt: string;
  metadata: Record<string, unknown>;
}

export interface ActionHistoryRow {
  id: string;
  fromState: string;
  toState: string;
  actorUserId: string | null;
  actorEmail: string | null;
  payload: Record<string, unknown>;
  actionVersion: number;
  createdAt: string;
}

export interface ActionRecord {
  id: string;
  organizationId: string;
  projectId: string;
  findingId: string;
  findingTitle: string;
  severity: string;
  ruleId: string;
  affectedUrls: string[];
  state: ActionState;
  version: number;
  recommendationVersion: string;
  recommendation: Record<string, unknown> | null;
  verificationGate: string;
  implementation: Record<string, unknown> | null;
  rollback: Record<string, unknown> | null;
  baseline: Record<string, unknown> | null;
  comparisonWindow: Record<string, unknown> | null;
  verification: Record<string, unknown> | null;
  priorityIndex: number;
  createdAt: string;
  updatedAt: string | null;
  evidence: ActionEvidenceRow[];
  history: ActionHistoryRow[];
}

interface DbActionRow {
  id: string;
  organization_id: string;
  project_id: string;
  finding_id: string;
  finding_title: string;
  severity: string;
  rule_id: string;
  affected_urls: string[];
  finding_gate: string;
  state: ActionState;
  version: number;
  recommendation_version: string;
  recommendation_json: Record<string, unknown> | null;
  verification_gate: string | null;
  implementation_json: Record<string, unknown> | null;
  rollback_json: Record<string, unknown> | null;
  baseline_json: Record<string, unknown> | null;
  comparison_window_json: Record<string, unknown> | null;
  verification_json: Record<string, unknown> | null;
  priority_index: number;
  created_at: Date;
  updated_at: Date | null;
}

const ACTION_SELECT = `
  SELECT a.id, a.organization_id, a.project_id, a.finding_id,
         f.title AS finding_title, f.severity, f.rule_id, f.affected_urls,
         f.verification_gate AS finding_gate, a.state, a.version,
         a.recommendation_version, a.recommendation_json, a.verification_gate,
         a.implementation_json, a.rollback_json, a.baseline_json,
         a.comparison_window_json, a.verification_json, a.priority_index,
         a.created_at, a.updated_at
    FROM actions a
    JOIN findings f ON f.id = a.finding_id
`;

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function hydrate(client: import("pg").PoolClient, row: DbActionRow): Promise<ActionRecord> {
  const evidence = await client.query<{
    id: string;
    kind: string;
    source_ref: string;
    content_hash: string;
    object_key: string;
    captured_at: Date;
    metadata_json: unknown;
  }>(
    `SELECT e.id, e.kind, e.source_ref, e.content_hash, e.object_key,
            e.captured_at, e.metadata_json
       FROM finding_evidence fe
       JOIN evidence_items e ON e.id = fe.evidence_id
      WHERE fe.organization_id = $2 AND fe.finding_id = $1 AND e.organization_id = $2
      ORDER BY e.captured_at DESC, e.id`,
    [row.finding_id, row.organization_id],
  );
  const history = await client.query<{
    id: string;
    from_state: string;
    to_state: string;
    actor_user_id: string | null;
    actor_email: string | null;
    payload: unknown;
    action_version: number;
    created_at: Date;
  }>(
    `SELECT id, from_state, to_state, actor_user_id, actor_email, payload,
            action_version, created_at
       FROM action_transitions
      WHERE action_id = $1 AND organization_id = $2
      ORDER BY action_version, created_at, id`,
    [row.id, row.organization_id],
  );
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    findingId: row.finding_id,
    findingTitle: row.finding_title,
    severity: row.severity,
    ruleId: row.rule_id,
    // findings.affected_urls is TEXT[] NOT NULL DEFAULT '{}' (migration 0004),
    // so the row type is honest and no fallback is needed.
    affectedUrls: row.affected_urls,
    state: row.state,
    version: row.version,
    recommendationVersion: row.recommendation_version,
    recommendation: objectOrNull(row.recommendation_json),
    verificationGate: row.verification_gate ?? row.finding_gate,
    implementation: objectOrNull(row.implementation_json),
    rollback: objectOrNull(row.rollback_json),
    baseline: objectOrNull(row.baseline_json),
    comparisonWindow: objectOrNull(row.comparison_window_json),
    verification: objectOrNull(row.verification_json),
    priorityIndex: row.priority_index,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at?.toISOString() ?? null,
    evidence: evidence.rows.map((e) => ({
      id: e.id,
      kind: e.kind,
      sourceRef: e.source_ref,
      contentHash: e.content_hash,
      objectKey: e.object_key,
      capturedAt: e.captured_at.toISOString(),
      metadata: publicEvidenceMetadata(e.metadata_json),
    })),
    history: history.rows.map((h) => ({
      id: h.id,
      fromState: h.from_state,
      toState: h.to_state,
      actorUserId: h.actor_user_id,
      actorEmail: h.actor_email,
      payload: objectOrNull(h.payload) ?? {},
      actionVersion: h.action_version,
      createdAt: h.created_at.toISOString(),
    })),
  };
}

export async function listActions(
  organizationId: string,
  projectId: string,
  filters: { state?: ActionState; severity?: string } = {},
): Promise<ActionRecord[]> {
  return withTenant(organizationId, async (client) => {
    const rows = await client.query<DbActionRow>(
      `${ACTION_SELECT}
       WHERE a.organization_id = $1 AND a.project_id = $2
         AND ($3::text IS NULL OR a.state = $3)
         AND ($4::text IS NULL OR f.severity = $4)
       ORDER BY a.priority_index DESC, a.created_at DESC, a.id`,
      [organizationId, projectId, filters.state ?? null, filters.severity ?? null],
    );
    // A pg client executes one query at a time. Hydrating every row via
    // Promise.all makes concurrent client.query calls on the same transaction,
    // which pg currently serializes but explicitly deprecates. Keep the single
    // tenant transaction and hydrate in order instead.
    const actions: ActionRecord[] = [];
    for (const row of rows.rows) actions.push(await hydrate(client, row));
    return actions;
  });
}

export async function getAction(
  organizationId: string,
  actionId: string,
): Promise<ActionRecord | null> {
  return withTenant(organizationId, async (client) => {
    const row = await client.query<DbActionRow>(
      `${ACTION_SELECT} WHERE a.organization_id = $1 AND a.id = $2`,
      [organizationId, actionId],
    );
    return row.rows[0] ? hydrate(client, row.rows[0]) : null;
  });
}

/**
 * Deterministic `gsc_window` verdict (Blueprint GateType).
 *
 * The decision is arithmetic over rows that Google actually returned and the
 * application actually persisted: the gate spec comes from the APPROVED
 * recommendation, the window from the MEASURING transition, and the numbers
 * from gsc_query_metrics. No state of the world is guessed — missing data or a
 * sample too small to judge yields INCONCLUSIVE, never a flattering PASS.
 */
async function gscWindowVerdict(
  client: import("pg").PoolClient,
  row: DbActionRow,
  window: { startsAt?: unknown; endsAt?: unknown },
  evaluatedAt: string,
): Promise<{ state: "VERIFIED" | "REJECTED" | "INCONCLUSIVE"; result: Record<string, unknown> }> {
  const gate = row.verification_gate ?? row.finding_gate;

  // A verification without a recorded measurement period is not a verification.
  const measuring = await client.query<{ created_at: Date }>(
    `SELECT created_at FROM action_transitions
      WHERE action_id = $1 AND to_state = 'MEASURING'
      ORDER BY action_version DESC LIMIT 1`,
    [row.id],
  );
  const measuringAt = measuring.rows[0]?.created_at;
  if (!measuringAt) {
    throw new ActionMutationError(
      "MEASUREMENT_REQUIRED",
      "Verification requires a recorded MEASURING transition.",
    );
  }

  const recommendation = row.recommendation_json as {
    verificationGate?: { spec?: Record<string, unknown> } | null;
  } | null;
  const spec = recommendation?.verificationGate?.spec;
  const metric = spec?.metric;
  const operator = spec?.operator;
  const threshold = spec?.threshold;
  const validMetric =
    metric === "ctr" || metric === "clicks" || metric === "impressions" || metric === "position";
  if (
    !spec ||
    !validMetric ||
    (operator !== "gte" && operator !== "lte") ||
    typeof threshold !== "number"
  ) {
    // The approved recommendation did not declare a computable gate: say so
    // instead of inventing a criterion at verification time.
    return {
      state: "INCONCLUSIVE",
      result: { gate, verdict: "INCONCLUSIVE", evaluatedAt, reason: "gate_spec_missing" },
    };
  }

  const minImpressions = typeof spec.minImpressions === "number" ? spec.minImpressions : 0;
  const filterQuery = typeof spec.query === "string" ? spec.query : null;
  const filterPage = typeof spec.page === "string" ? spec.page : null;
  const filterDevice = typeof spec.device === "string" ? spec.device : null;
  const filterCountry = typeof spec.country === "string" ? spec.country : null;
  const filterConnectionId = typeof spec.connectionId === "string" ? spec.connectionId : null;

  // The declared comparison window wins; otherwise MEASURING → now.
  const start = new Date(
    typeof window.startsAt === "string" ? window.startsAt : measuringAt.toISOString(),
  );
  const end = new Date(typeof window.endsAt === "string" ? window.endsAt : evaluatedAt);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);

  const aggregate = await client.query<{
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
    rows: number;
  }>(
    `SELECT sum(clicks)::float8 AS clicks,
            sum(impressions)::float8 AS impressions,
            CASE WHEN sum(impressions) > 0 THEN sum(clicks) / sum(impressions) ELSE 0 END AS ctr,
            CASE WHEN sum(impressions) > 0
                 THEN sum(position * impressions) / sum(impressions) ELSE 0 END AS position,
            count(*)::int AS rows
       FROM gsc_query_metrics AS metric
       JOIN gsc_sync_jobs AS job
         ON job.id = metric.sync_job_id
        AND job.organization_id = metric.organization_id
        AND job.project_id = metric.project_id
      WHERE metric.organization_id = $1
        AND metric.project_id = $2
        AND job.status = 'COMPLETED'
        AND metric.metric_date BETWEEN $3::date AND $4::date
        AND ($5::text IS NULL OR metric.query = $5)
        AND ($6::text IS NULL OR metric.page = $6)
        AND ($7::text IS NULL OR metric.device = $7)
        AND ($8::text IS NULL OR metric.country = $8)
        AND ($9::uuid IS NULL OR job.connection_id = $9)`,
    [
      row.organization_id,
      row.project_id,
      startDate,
      endDate,
      filterQuery,
      filterPage,
      filterDevice,
      filterCountry,
      filterConnectionId,
    ],
  );
  const stats = aggregate.rows[0];
  const metricRows = stats?.rows ?? 0;
  const filters = {
    metric,
    operator,
    threshold,
    query: filterQuery,
    page: filterPage,
    device: filterDevice,
    country: filterCountry,
    connectionId: filterConnectionId,
    minImpressions,
  };

  if (metricRows === 0) {
    return {
      state: "INCONCLUSIVE",
      result: {
        gate,
        verdict: "INCONCLUSIVE",
        evaluatedAt,
        reason: "no_gsc_data_in_window",
        window: { startDate, endDate },
        filters,
      },
    };
  }

  const impressions = stats?.impressions ?? 0;
  const observed = {
    clicks: stats?.clicks ?? 0,
    impressions,
    ctr: stats?.ctr ?? 0,
    position: stats?.position ?? 0,
    metricRows,
  };
  if (impressions < minImpressions) {
    return {
      state: "INCONCLUSIVE",
      result: {
        gate,
        verdict: "INCONCLUSIVE",
        evaluatedAt,
        reason: "insufficient_sample",
        window: { startDate, endDate },
        filters,
        observed,
      },
    };
  }

  const value = observed[metric];
  const passed = operator === "gte" ? value >= threshold : value <= threshold;
  return {
    state: passed ? "VERIFIED" : "REJECTED",
    result: {
      gate,
      verdict: passed ? "PASS" : "FAIL",
      evaluatedAt,
      window: { startDate, endDate },
      filters,
      observed,
      comparedValue: value,
      source: "gsc_query_metrics",
    },
  };
}

async function deterministicGateVerdict(
  client: import("pg").PoolClient,
  row: DbActionRow,
  window: { startsAt?: unknown; endsAt?: unknown },
): Promise<{ state: "VERIFIED" | "REJECTED" | "INCONCLUSIVE"; result: Record<string, unknown> }> {
  const evaluatedAt = new Date().toISOString();
  const gate = row.verification_gate ?? row.finding_gate;
  if (gate === "gsc_window") {
    return gscWindowVerdict(client, row, window, evaluatedAt);
  }
  if (gate !== "recrawl_rule_absent") {
    return {
      state: "INCONCLUSIVE",
      result: { gate, verdict: "INCONCLUSIVE", evaluatedAt, reason: "unsupported_gate" },
    };
  }

  const measuring = await client.query<{ created_at: Date }>(
    `SELECT created_at FROM action_transitions
      WHERE action_id = $1 AND to_state = 'MEASURING'
      ORDER BY action_version DESC LIMIT 1`,
    [row.id],
  );
  if (!measuring.rows[0]) {
    throw new ActionMutationError(
      "MEASUREMENT_REQUIRED",
      "Verification requires a recorded MEASURING transition.",
    );
  }

  const startsAt =
    typeof window.startsAt === "string"
      ? window.startsAt
      : measuring.rows[0].created_at.toISOString();
  const endsAt = typeof window.endsAt === "string" ? window.endsAt : evaluatedAt;
  const run = await client.query<{ id: string; started_at: Date; completed_at: Date }>(
    `SELECT id, started_at, completed_at
       FROM crawl_runs
      WHERE organization_id = $1 AND project_id = $2 AND status = 'completed'
        AND started_at >= GREATEST($3::timestamptz, $4::timestamptz)
        AND completed_at <= $5::timestamptz
      ORDER BY completed_at DESC, id DESC LIMIT 1`,
    [row.organization_id, row.project_id, measuring.rows[0].created_at, startsAt, endsAt],
  );
  if (!run.rows[0]) {
    return {
      state: "INCONCLUSIVE",
      result: {
        gate,
        verdict: "INCONCLUSIVE",
        evaluatedAt,
        reason: "no_completed_crawl_in_window",
      },
    };
  }

  const matching = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM findings
      WHERE organization_id = $1 AND project_id = $2 AND crawl_run_id = $3
        AND rule_id = $4`,
    [row.organization_id, row.project_id, run.rows[0].id, row.rule_id],
  );
  const evidence = await client.query<{ id: string }>(
    `SELECT id FROM evidence_items
      WHERE organization_id = $1 AND project_id = $2 AND crawl_run_id = $3
      ORDER BY captured_at, id`,
    [row.organization_id, row.project_id, run.rows[0].id],
  );
  const count = matching.rows[0]?.n ?? 0;
  const passed = count === 0;
  return {
    state: passed ? "VERIFIED" : "REJECTED",
    result: {
      gate,
      verdict: passed ? "PASS" : "FAIL",
      evaluatedAt,
      crawlRunId: run.rows[0].id,
      matchingFindingCount: count,
      evidenceIds: evidence.rows.map((item) => item.id),
    },
  };
}

export async function transitionAction(
  organizationId: string,
  actionId: string,
  actor: ActionActor,
  input: ActionTransitionInput,
): Promise<ActionRecord> {
  return withTenant(organizationId, async (client) => {
    const selected = await client.query<DbActionRow>(
      `${ACTION_SELECT} WHERE a.organization_id = $1 AND a.id = $2 FOR UPDATE OF a`,
      [organizationId, actionId],
    );
    const row = selected.rows[0];
    if (!row) throw new ActionMutationError("ACTION_NOT_FOUND", "Action not found.");
    if (row.version !== input.expectedVersion) {
      throw new ActionMutationError(
        "VERSION_CONFLICT",
        `Action version is ${row.version}; expected ${input.expectedVersion}.`,
      );
    }
    let toState: ActionState =
      input.toState === "EVALUATE"
        ? "INCONCLUSIVE"
        : input.toState === "REJECT_PROPOSAL"
          ? "EVIDENCED"
          : input.toState;
    if (input.toState === "EVALUATE" && row.state !== "MEASURING") {
      throw new ActionMutationError(
        "INVALID_TRANSITION",
        `Gate evaluation is only valid from MEASURING, not ${row.state}.`,
      );
    }
    if (input.toState === "REJECT_PROPOSAL") {
      if (row.state !== "PROPOSED") {
        throw new ActionMutationError(
          "INVALID_TRANSITION",
          `A proposal can only be rejected from PROPOSED, not ${row.state}.`,
        );
      }
      if (input.approvalDecision !== "REJECT" || !input.note?.trim()) {
        throw new ActionMutationError(
          "APPROVAL_REQUIRED",
          "Rejecting a proposal requires an explicit REJECT decision and a reason.",
        );
      }
    } else if (input.toState !== "EVALUATE" && !TRANSITIONS[row.state].includes(toState)) {
      throw new ActionMutationError(
        "INVALID_TRANSITION",
        `Transition ${row.state} → ${toState} is forbidden.`,
      );
    }

    let recommendation = row.recommendation_json;
    let verificationGate = row.verification_gate ?? row.finding_gate;
    let implementation = row.implementation_json;
    let rollback = row.rollback_json;
    let baseline = row.baseline_json;
    let comparisonWindow = row.comparison_window_json;
    let verification = row.verification_json;

    if (toState === "EVIDENCED") {
      const linked = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM finding_evidence
          WHERE organization_id = $1 AND finding_id = $2`,
        [row.organization_id, row.finding_id],
      );
      if ((linked.rows[0]?.n ?? 0) === 0) {
        throw new ActionMutationError(
          "EVIDENCE_REQUIRED",
          "An action cannot become EVIDENCED without linked evidence.",
        );
      }
    }

    if (toState === "PROPOSED") {
      if (!input.recommendation?.summary.trim() || !input.recommendation.verificationGate.type) {
        throw new ActionMutationError(
          "RECOMMENDATION_REQUIRED",
          "A proposal requires a recommendation and a declared verification gate.",
        );
      }
      if (input.recommendation.verificationGate.type !== row.finding_gate) {
        throw new ActionMutationError(
          "RECOMMENDATION_REQUIRED",
          "The recommendation gate must match the finding's persisted gate.",
        );
      }
      const measuredGateMismatch = await client.query<{ mismatch: boolean }>(
        `WITH latest_gsc_evidence AS (
           SELECT e.metadata_json
             FROM finding_evidence fe
             JOIN evidence_items e
               ON e.id = fe.evidence_id AND e.organization_id = fe.organization_id
            WHERE fe.organization_id = $1 AND fe.finding_id = $2
              AND e.kind = 'gsc_data'
              AND e.metadata_json ? 'verificationGate'
            ORDER BY e.captured_at DESC, e.id DESC
            LIMIT 1
         )
         SELECT true AS mismatch FROM latest_gsc_evidence
          WHERE metadata_json->'verificationGate' IS DISTINCT FROM $3::jsonb`,
        [
          row.organization_id,
          row.finding_id,
          JSON.stringify(input.recommendation.verificationGate),
        ],
      );
      if (measuredGateMismatch.rows[0]) {
        throw new ActionMutationError(
          "RECOMMENDATION_REQUIRED",
          "A measured GSC proposal must preserve the verification gate recorded in its evidence.",
        );
      }
      recommendation = input.recommendation;
      verificationGate = input.recommendation.verificationGate.type;
    }

    if (toState === "APPROVED" && input.approvalDecision !== "APPROVE") {
      throw new ActionMutationError(
        "APPROVAL_REQUIRED",
        "APPROVED requires an explicit APPROVE decision.",
      );
    }

    if (toState === "REPORTED_MANUALLY") {
      if (!input.implementation?.whatChanged.trim() || !input.implementation.how.trim()) {
        throw new ActionMutationError(
          "IMPLEMENTATION_REQUIRED",
          "REPORTED_MANUALLY requires what was changed and how it was published.",
        );
      }
      if (!input.rollback?.strategy.trim()) {
        throw new ActionMutationError(
          "IMPLEMENTATION_REQUIRED",
          "REPORTED_MANUALLY requires rollback instructions.",
        );
      }
      implementation = {
        ...input.implementation,
        reportedAt: new Date().toISOString(),
        reportedBy: actor.userId,
        reportedByEmail: actor.email,
      };
      rollback = input.rollback;
    }

    if (toState === "MEASURING") {
      const start = Date.parse(input.comparisonWindow?.startsAt ?? "");
      const end = Date.parse(input.comparisonWindow?.endsAt ?? "");
      if (
        !input.baselineSnapshot ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start
      ) {
        throw new ActionMutationError(
          "MEASUREMENT_REQUIRED",
          "MEASURING requires a baseline snapshot and a valid comparison window.",
        );
      }
      baseline = input.baselineSnapshot;
      comparisonWindow = input.comparisonWindow ?? null;
    }

    if (row.state === "MEASURING" && ["VERIFIED", "REJECTED", "INCONCLUSIVE"].includes(toState)) {
      if (!comparisonWindow) {
        throw new ActionMutationError(
          "MEASUREMENT_REQUIRED",
          "Verification cannot run without a preserved measurement window.",
        );
      }
      const evaluated = await deterministicGateVerdict(client, row, comparisonWindow);
      if (input.toState !== "EVALUATE" && toState !== evaluated.state) {
        throw new ActionMutationError(
          "GATE_VERDICT_MISMATCH",
          `Declared gate determined ${evaluated.state}, not ${toState}.`,
        );
      }
      toState = evaluated.state;
      verification = evaluated.result;
    }

    const payload = {
      ...(input.note ? { note: input.note } : {}),
      ...(toState === "PROPOSED" ? { recommendation } : {}),
      ...(toState === "APPROVED" ? { approvalDecision: "APPROVE" } : {}),
      ...(input.toState === "REJECT_PROPOSAL" ? { approvalDecision: "REJECT" } : {}),
      ...(toState === "REPORTED_MANUALLY" ? { implementation, rollback } : {}),
      ...(toState === "MEASURING" ? { baseline, comparisonWindow } : {}),
      ...(row.state === "MEASURING" && ["VERIFIED", "REJECTED", "INCONCLUSIVE"].includes(toState)
        ? { verification }
        : {}),
    };
    const updated = await client.query<DbActionRow>(
      `UPDATE actions
          SET state = $3, version = version + 1, recommendation_json = $4::jsonb,
              verification_gate = $5, implementation_json = $6::jsonb,
              rollback_json = $7::jsonb, baseline_json = $8::jsonb,
              comparison_window_json = $9::jsonb, verification_json = $10::jsonb,
              updated_at = now()
        WHERE organization_id = $1 AND id = $2 AND version = $11 AND state = $12
        RETURNING *`,
      [
        organizationId,
        actionId,
        toState,
        JSON.stringify(recommendation),
        verificationGate,
        JSON.stringify(implementation),
        JSON.stringify(rollback),
        JSON.stringify(baseline),
        JSON.stringify(comparisonWindow),
        JSON.stringify(verification),
        input.expectedVersion,
        row.state,
      ],
    );
    if (!updated.rows[0]) {
      throw new ActionMutationError("VERSION_CONFLICT", "The action changed concurrently.");
    }
    const nextVersion = input.expectedVersion + 1;
    await client.query(
      `INSERT INTO action_transitions
         (organization_id, action_id, from_state, to_state, actor_user_id,
          actor_email, payload, action_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        organizationId,
        actionId,
        row.state,
        toState,
        actor.userId,
        actor.email,
        JSON.stringify(payload),
        nextVersion,
      ],
    );
    const fresh = await client.query<DbActionRow>(
      `${ACTION_SELECT} WHERE a.organization_id = $1 AND a.id = $2`,
      [organizationId, actionId],
    );
    const freshRow = fresh.rows[0];
    if (!freshRow) {
      // Unreachable: the row was SELECT ... FOR UPDATE'd earlier in this txn.
      throw new ActionMutationError("ACTION_NOT_FOUND", "Action not found.");
    }
    return hydrate(client, freshRow);
  });
}
