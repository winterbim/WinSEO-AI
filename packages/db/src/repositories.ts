// ─── Repository layer ───
// DB-backed data access replacing in-memory stores. Every tenant-scoped read/
// write goes through withTenant() so PostgreSQL RLS enforces isolation at the
// database boundary — not merely application WHERE clauses.

import { withAdmin, withTenant, getPool, query } from "./client.ts";

/**
 * INSERT ... RETURNING must produce exactly one row. Turn the impossible case
 * into an explicit invariant error instead of a non-null assertion.
 */
function requireRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Database invariant violated: INSERT ... RETURNING produced no row");
  }
  return row;
}

// ═══════════ Users (cross-tenant: login happens before tenant is known) ═══════════
export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  created_at: Date;
}

/**
 * Create a user. Runs as admin (users table is not RLS-guarded).
 * Password hashing is the caller's responsibility (auth layer) to keep this
 * package free of auth-crypto duplication.
 */
export async function createUser(
  email: string,
  passwordHash: string,
  name?: string,
): Promise<UserRow> {
  const res = await query<UserRow & { email: string }>(
    `INSERT INTO users (email, password_hash, name)
     VALUES (lower($1), $2, $3)
     RETURNING id, email, name, created_at`,
    [email, passwordHash, name ?? null],
  );
  return requireRow(res.rows);
}

/** Find a user by email (login). Returns password hash separately for verify. */
export async function findUserByEmail(
  email: string,
): Promise<(UserRow & { password_hash: string | null }) | null> {
  const res = await query<UserRow & { password_hash: string | null }>(
    `SELECT id, email, name, created_at, password_hash
       FROM users WHERE email = lower($1) AND deleted_at IS NULL`,
    [email],
  );
  return res.rows[0] ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const res = await query<UserRow>(
    `SELECT id, email, name, created_at FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return res.rows[0] ?? null;
}

// ═══════════ Organizations (tenant root — created via admin, membership-gated after) ═══════════
export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  plan_id: string;
  region: string;
  created_at: Date;
}

/** Create an organization and make `ownerUserId` its OWNER in one transaction. */
export async function createOrganization(
  ownerUserId: string,
  name: string,
  slug: string,
): Promise<OrganizationRow> {
  return withAdmin(async (client) => {
    const orgRes = await client.query<OrganizationRow>(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2)
       RETURNING id, name, slug, plan_id, region, created_at`,
      [name, slug],
    );
    const org = requireRow(orgRes.rows);
    await client.query(
      `INSERT INTO memberships (user_id, organization_id, role, status)
       VALUES ($1, $2, 'OWNER', 'active')`,
      [ownerUserId, org.id],
    );
    return org;
  });
}

/** Read one organization, but ONLY if the requesting user is an active member.
 * Membership check is the authorization gate; organizations itself is not RLS'd
 * because it is the tenant root.
 */
export async function getOrganizationForMember(
  userId: string,
  organizationId: string,
): Promise<OrganizationRow | null> {
  const res = await query<OrganizationRow>(
    `SELECT o.id, o.name, o.slug, o.plan_id, o.region, o.created_at
       FROM organizations o
       JOIN memberships m ON m.organization_id = o.id
      WHERE o.id = $1 AND o.deleted_at IS NULL
        AND m.user_id = $2 AND m.status = 'active'`,
    [organizationId, userId],
  );
  return res.rows[0] ?? null;
}

/**
 * Return the caller's role within an organization, or null when not an active
 * member. Used to derive the tenant context SERVER-SIDE so the session never
 * needs to carry a client-asserted role that RLS would then have to trust.
 */
export async function getMembershipRole(
  userId: string,
  organizationId: string,
): Promise<string | null> {
  const res = await query<{ role: string }>(
    `SELECT role FROM memberships
      WHERE user_id = $1 AND organization_id = $2 AND status = 'active'`,
    [userId, organizationId],
  );
  return res.rows[0]?.role ?? null;
}

/** List all organizations a user is an active member of. */
export async function listOrganizationsForUser(
  userId: string,
): Promise<(OrganizationRow & { role: string })[]> {
  const res = await query<OrganizationRow & { role: string }>(
    `SELECT o.id, o.name, o.slug, o.plan_id, o.region, o.created_at, m.role
       FROM organizations o
       JOIN memberships m ON m.organization_id = o.id
      WHERE m.user_id = $1 AND m.status = 'active' AND o.deleted_at IS NULL
      ORDER BY o.created_at`,
    [userId],
  );
  return res.rows;
}

// ═══════════ Projects (tenant-owned + RLS) ═══════════
export interface ProjectRow {
  id: string;
  organization_id: string;
  name: string;
  primary_domain: string;
  timezone: string;
  default_locale: string;
  status: string;
  created_at: Date;
}

/**
 * Create a project. Runs under the tenant's runtime role with the org GUC set,
 * so RLS WITH CHECK enforces organization_id == current tenant. A caller cannot
 * insert a project into another org even by passing a foreign organization_id.
 */
export async function createProject(
  organizationId: string,
  name: string,
  primaryDomain: string,
): Promise<ProjectRow> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query<ProjectRow>(
      `INSERT INTO projects (organization_id, name, primary_domain)
       VALUES ($1, $2, $3)
       RETURNING id, organization_id, name, primary_domain, timezone, default_locale, status, created_at`,
      [organizationId, name, primaryDomain],
    );
    return requireRow(res.rows);
  });
}

/** Get a single project visible to the current tenant (RLS-filtered). */
export async function getProject(
  organizationId: string,
  projectId: string,
): Promise<ProjectRow | null> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query<ProjectRow>(
      `SELECT id, organization_id, name, primary_domain, timezone, default_locale, status, created_at
         FROM projects WHERE id = $1`,
      [projectId],
    );
    return res.rows[0] ?? null;
  });
}

/** List projects for the current tenant (RLS-filtered). */
export async function listProjects(organizationId: string): Promise<ProjectRow[]> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query<ProjectRow>(
      `SELECT id, organization_id, name, primary_domain, timezone, default_locale, status, created_at
         FROM projects WHERE deleted_at IS NULL ORDER BY created_at`,
    );
    return res.rows;
  });
}

export { getPool };

// ═══════════ Public scans (anonymous, non-tenant; gated by unguessable UUID) ═══════════
export interface PublicScanRow {
  id: string;
  domain: string;
  status: "pending" | "running" | "completed" | "failed";
  created_at: Date;
  completed_at: Date | null;
  findings: unknown;
  evidence: unknown;
  error: string | null;
}

/** Create a public scan record. Returns the generated UUID (non-predictable). */
export async function createPublicScan(domain: string): Promise<PublicScanRow> {
  const res = await query<PublicScanRow>(
    `INSERT INTO public_scans (domain, status) VALUES ($1, 'pending')
     RETURNING id, domain, status, created_at, completed_at, findings, evidence, error`,
    [domain],
  );
  return requireRow(res.rows);
}

/** Fetch a public scan by its UUID. Returns null if absent (no info leak). */
export async function getPublicScan(id: string): Promise<PublicScanRow | null> {
  const res = await query<PublicScanRow>(
    `SELECT id, domain, status, created_at, completed_at, findings, evidence, error
       FROM public_scans WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

/** Update scan status/findings after the crawl completes. */
export async function updatePublicScanResult(
  id: string,
  status: PublicScanRow["status"],
  findings: unknown[],
  evidence: unknown[],
  error?: string,
): Promise<void> {
  await query(
    `UPDATE public_scans
        SET status = $2, findings = $3::jsonb, evidence = $4::jsonb,
            error = $5, completed_at = now()
      WHERE id = $1`,
    [id, status, JSON.stringify(findings), JSON.stringify(evidence), error ?? null],
  );
}

// ═══════════ Project crawl runs / findings / evidence (tenant-scoped, RLS) ═══════════
// Every write goes through withTenant() so RLS WITH CHECK enforces
// organization_id == current tenant; every read is RLS-filtered.

export interface FindingInsert {
  organization_id: string;
  project_id: string;
  rule_id: string;
  rule_version: string;
  title: string;
  epistemic_class: string;
  severity: string;
  explanation?: string;
  recommendation?: string;
  affected_urls?: string[];
  verification_gate?: string;
  crawl_run_id?: string;
}

export interface FindingRow {
  id: string;
  organization_id: string;
  project_id: string;
  rule_id: string;
  rule_version: string;
  title: string;
  epistemic_class: string;
  severity: string;
  status: string;
  confidence: number;
  explanation: string | null;
  recommendation: string | null;
  first_seen_at: Date;
  affected_urls: string[] | null;
  verification_gate: string | null;
  /** State of the linked action row, when one exists (LEFT JOIN). */
  action_state?: string | null;
}

export interface EvidenceRow {
  id: string;
  kind: string;
  source_ref: string;
  content_hash: string;
  object_key: string;
  captured_at: Date;
  metadata_json: unknown;
}

export interface CrawlRunRow {
  id: string;
  status: string;
  mode: string;
  // Column is nullable (0001_init_schema.sql) and the list query even sorts
  // `NULLS LAST` — the row type must say so.
  started_at: Date | null;
  completed_at: Date | null;
  pages_crawled: number;
  pages_failed: number;
}

export interface EvidenceInsert {
  organization_id: string;
  project_id: string;
  kind: string;
  source_ref: string;
  content_hash: string;
  object_key: string;
  metadata_json?: unknown;
  crawl_run_id?: string;
}

/** Create a crawl run for a tenant project (RLS WITH CHECK on insert). */
export async function createCrawlRun(
  organizationId: string,
  projectId: string,
  mode: string,
): Promise<{ id: string }> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query<{ id: string }>(
      `INSERT INTO crawl_runs (organization_id, project_id, mode, seed_strategy, status, started_at)
       VALUES ($1, $2, $3, 'SITEMAP', 'running', now())
       RETURNING id`,
      [organizationId, projectId, mode],
    );
    return requireRow(res.rows);
  });
}

/** Mark a crawl run terminal (RLS: only the owning tenant can update). */
export async function finishCrawlRun(
  organizationId: string,
  runId: string,
  status: "completed" | "failed",
  pagesCrawled: number,
  pagesFailed: number,
): Promise<void> {
  await withTenant(organizationId, async (client) => {
    await client.query(
      `UPDATE crawl_runs
          SET status = $3, completed_at = now(),
              pages_crawled = $4, pages_failed = $5
        WHERE id = $2 AND organization_id = $1`,
      [organizationId, runId, status, pagesCrawled, pagesFailed],
    );
  });
}

/** Persist one finding as a first-class row (tenant-scoped). */
export async function addFinding(f: FindingInsert): Promise<{ id: string }> {
  return withTenant(f.organization_id, async (client) => {
    const res = await client.query<{ id: string }>(
      `INSERT INTO findings
         (organization_id, project_id, rule_id, rule_version, rule_hash, title,
          epistemic_class, severity, status, confidence, explanation, recommendation,
          affected_urls, verification_gate, crawl_run_id)
       VALUES ($1, $2, $3, $4, '', $5, $6, $7, 'open', 1.0, $8, $9, $10::text[], $11, $12)
       RETURNING id`,
      [
        f.organization_id,
        f.project_id,
        f.rule_id,
        f.rule_version,
        f.title,
        f.epistemic_class,
        f.severity,
        f.explanation ?? null,
        f.recommendation ?? null,
        f.affected_urls ?? [],
        f.verification_gate ?? "recrawl_rule_absent",
        f.crawl_run_id ?? null,
      ],
    );
    return requireRow(res.rows);
  });
}

/** Persist one evidence item (tenant-scoped; content hash for reproducibility). */
export async function addEvidence(e: EvidenceInsert): Promise<{ id: string }> {
  return withTenant(e.organization_id, async (client) => {
    const res = await client.query<{ id: string }>(
      `INSERT INTO evidence_items
         (organization_id, project_id, kind, source_ref, content_hash, object_key,
          metadata_json, crawl_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       RETURNING id`,
      [
        e.organization_id,
        e.project_id,
        e.kind,
        e.source_ref,
        e.content_hash,
        e.object_key,
        JSON.stringify(e.metadata_json ?? {}),
        e.crawl_run_id ?? null,
      ],
    );
    return requireRow(res.rows);
  });
}

const FINDING_COLUMNS = `f.id, f.organization_id, f.project_id, f.rule_id, f.rule_version,
       f.title, f.epistemic_class, f.severity, f.status, f.confidence,
       f.explanation, f.recommendation, f.first_seen_at,
       f.affected_urls, f.verification_gate`;

/** List findings for a project — RLS filters foreign-tenant rows to zero.
 *  LEFT JOIN carries the linked action's state (state machine §17.1). */
export async function listFindings(
  organizationId: string,
  projectId: string,
): Promise<FindingRow[]> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query<FindingRow>(
      `SELECT ${FINDING_COLUMNS}, a.state AS action_state
         FROM findings f
         LEFT JOIN LATERAL (
           SELECT state FROM actions
            WHERE finding_id = f.id AND organization_id = f.organization_id
            ORDER BY created_at ASC LIMIT 1
         ) a ON true
        WHERE f.organization_id = $1 AND f.project_id = $2
        ORDER BY f.first_seen_at DESC`,
      [organizationId, projectId],
    );
    return res.rows;
  });
}

/** Finding detail (RLS-scoped): null when the finding belongs to another org. */
export async function getFinding(
  organizationId: string,
  findingId: string,
): Promise<FindingRow | null> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query<FindingRow>(
      `SELECT ${FINDING_COLUMNS}, a.state AS action_state
         FROM findings f
         LEFT JOIN LATERAL (
           SELECT state FROM actions
            WHERE finding_id = f.id AND organization_id = f.organization_id
            ORDER BY created_at ASC LIMIT 1
         ) a ON true
        WHERE f.organization_id = $1 AND f.id = $2`,
      [organizationId, findingId],
    );
    return res.rows[0] ?? null;
  });
}

/** Evidence rows linked to a finding (relation 'supports'), RLS-scoped. */
export async function getFindingEvidence(
  organizationId: string,
  findingId: string,
): Promise<EvidenceRow[]> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query<EvidenceRow>(
      `SELECT e.id, e.kind, e.source_ref, e.content_hash, e.object_key,
              e.captured_at, e.metadata_json
         FROM finding_evidence fe
         JOIN evidence_items e ON e.id = fe.evidence_id
        WHERE fe.finding_id = $2 AND e.organization_id = $1
        ORDER BY e.captured_at DESC`,
      [organizationId, findingId],
    );
    return res.rows;
  });
}

/** Record that an evidence item supports a finding (Blueprint §11.3).
 *  The evidence row's own RLS predicates guard the link. */
export async function linkFindingEvidence(
  organizationId: string,
  findingId: string,
  evidenceId: string,
): Promise<void> {
  await withTenant(organizationId, async (client) => {
    await client.query(
      `INSERT INTO finding_evidence (finding_id, evidence_id, relation)
       SELECT f.id, e.id, 'supports'
         FROM findings f, evidence_items e
        WHERE f.id = $2 AND f.organization_id = $1
          AND e.id = $3 AND e.organization_id = $1
       ON CONFLICT (finding_id, evidence_id) DO NOTHING`,
      [organizationId, findingId, evidenceId],
    );
  });
}

/** Evidence items of a project (drawer listing), RLS-scoped. */
export async function listEvidence(
  organizationId: string,
  projectId: string,
): Promise<EvidenceRow[]> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query<EvidenceRow>(
      `SELECT id, kind, source_ref, content_hash, object_key, captured_at, metadata_json
         FROM evidence_items
        WHERE organization_id = $1 AND project_id = $2
        ORDER BY captured_at DESC`,
      [organizationId, projectId],
    );
    return res.rows;
  });
}

/** Crawl history for a project, newest first, RLS-scoped. */
export async function listCrawlRuns(
  organizationId: string,
  projectId: string,
): Promise<CrawlRunRow[]> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query<CrawlRunRow>(
      `SELECT id, status, mode, started_at, completed_at, pages_crawled, pages_failed
         FROM crawl_runs
        WHERE organization_id = $1 AND project_id = $2
        ORDER BY started_at DESC NULLS LAST, id DESC`,
      [organizationId, projectId],
    );
    return res.rows;
  });
}

/** Create the workflow entry for a finding in state DETECTED (§17.1).
 *  Idempotent: one action per finding. */
export async function createDetectedAction(
  organizationId: string,
  projectId: string,
  findingId: string,
): Promise<{ id: string }> {
  return withTenant(organizationId, async (client) => {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM actions
        WHERE organization_id = $1 AND finding_id = $3 AND project_id = $2
        LIMIT 1`,
      [organizationId, projectId, findingId],
    );
    if (existing.rows[0]) return existing.rows[0];
    const res = await client.query<{ id: string }>(
      `INSERT INTO actions
         (organization_id, project_id, finding_id, state, verification_gate)
       SELECT $1, $2, f.id, 'DETECTED', f.verification_gate
         FROM findings f
        WHERE f.id = $3 AND f.organization_id = $1 AND f.project_id = $2
       RETURNING id`,
      [organizationId, projectId, findingId],
    );
    return requireRow(res.rows);
  });
}
