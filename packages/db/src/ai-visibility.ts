import {
  wilsonInterval95,
  type OrgRole,
  type AiVisibilityCapture,
  type AiVisibilityStat,
} from "@serpvera/contracts";
import { hasPermission } from "@serpvera/authz";
import { withTenant } from "./client.ts";

export interface AiVisibilityImportRow {
  id: string;
  project_id: string;
  uploaded_by: string | null;
  csv_sha256: string;
  row_count: number;
  provenance: "USER_SUPPLIED";
  epistemic_class: "DOCUMENTED";
  unverified_by_provider: true;
  created_at: Date;
}

export interface AiVisibilityCaptureRow {
  id: string;
  import_id: string;
  row_number: number;
  engine: string;
  prompt_id: string;
  brand_mentioned: boolean;
  client_cited: boolean;
  citation_domains: string[];
  sampled_at: Date;
}

interface AiVisibilityStatsDbRow extends Record<string, unknown> {
  engine: string;
  prompt_id: string;
  prompts_observed: number;
  runs: number;
  mention_count: number;
  citation_count: number;
  mention_rate: number;
  citation_rate: number;
  unique_citation_domains: number;
  top_citation_domains: [string, number][] | null;
}

export class AiVisibilityDuplicateImportError extends Error {
  constructor() {
    super("This CSV has already been imported for this project.");
    this.name = "AiVisibilityDuplicateImportError";
  }
}

export class AiVisibilityProjectScopeError extends Error {
  constructor() {
    super("Project not found in this organization.");
    this.name = "AiVisibilityProjectScopeError";
  }
}

export class AiVisibilityPermissionError extends Error {
  constructor() {
    super("The active organization role cannot write AI visibility evidence.");
    this.name = "AiVisibilityPermissionError";
  }
}

/** Store an immutable batch and all parsed rows in one tenant transaction. */
export async function createAiVisibilityImport(input: {
  organizationId: string;
  projectId: string;
  uploadedBy: string;
  csvSha256: string;
  captures: readonly AiVisibilityCapture[];
}): Promise<AiVisibilityImportRow> {
  return withTenant(input.organizationId, async (client) => {
    const membership = await client.query<{ role: string }>(
      `SELECT role FROM memberships
        WHERE user_id = $1 AND organization_id = $2 AND status = 'active'
        FOR SHARE`,
      [input.uploadedBy, input.organizationId],
    );
    const role = membership.rows[0]?.role;
    if (!role || !isOrgRole(role) || !hasPermission(role, "evidence.write")) {
      throw new AiVisibilityPermissionError();
    }

    let result: AiVisibilityImportRow;
    try {
      const inserted = await client.query<AiVisibilityImportRow>(
        `INSERT INTO ai_visibility_imports
           (organization_id, project_id, uploaded_by, csv_sha256, row_count)
         SELECT $1, p.id, $3, $4, $5
           FROM projects p
          WHERE p.id = $2 AND p.organization_id = $1
         RETURNING id, project_id, uploaded_by, csv_sha256, row_count, provenance,
                   epistemic_class, unverified_by_provider, created_at`,
        [
          input.organizationId,
          input.projectId,
          input.uploadedBy,
          input.csvSha256,
          input.captures.length,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new AiVisibilityProjectScopeError();
      result = row;

      const serializedCaptures = JSON.stringify(
        input.captures.map((capture) => ({
          engine: capture.engine,
          prompt_id: capture.promptId,
          brand_mentioned: capture.brandMentioned,
          client_cited: capture.clientCited,
          citation_domains: capture.citationDomains,
          sampled_at: capture.sampledAt ?? null,
        })),
      );
      await client.query(
        `INSERT INTO ai_visibility_captures
           (organization_id, project_id, import_id, row_number, engine, prompt_id,
            brand_mentioned, client_cited, citation_domains, sampled_at)
         SELECT $1, $2, $3, input.row_number::int, capture.engine, capture.prompt_id,
                capture.brand_mentioned, capture.client_cited,
                COALESCE(capture.citation_domains, '{}'::text[]),
                COALESCE(capture.sampled_at, imported.created_at)
           FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS input(value, row_number)
           CROSS JOIN LATERAL jsonb_to_record(input.value) AS capture(
             engine text,
             prompt_id text,
             brand_mentioned boolean,
             client_cited boolean,
             citation_domains text[],
             sampled_at timestamptz
           )
           JOIN ai_visibility_imports imported
             ON imported.organization_id = $1
            AND imported.project_id = $2
            AND imported.id = $3`,
        [input.organizationId, input.projectId, result.id, serializedCaptures],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new AiVisibilityDuplicateImportError();
      throw err;
    }
    return result;
  });
}

function isOrgRole(value: string): value is OrgRole {
  return ["OWNER", "ADMIN", "ANALYST", "EDITOR", "VIEWER", "BILLING"].includes(value);
}

export async function listAiVisibilityImports(
  organizationId: string,
  projectId: string,
  limit: number,
  offset: number,
): Promise<AiVisibilityImportRow[]> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query<AiVisibilityImportRow>(
      `SELECT id, project_id, uploaded_by, csv_sha256, row_count, provenance,
              epistemic_class, unverified_by_provider, created_at
         FROM ai_visibility_imports
        WHERE organization_id = $1 AND project_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT $3 OFFSET $4`,
      [organizationId, projectId, limit, offset],
    );
    return res.rows;
  });
}

export async function getAiVisibilityImport(
  organizationId: string,
  projectId: string,
  importId: string,
): Promise<AiVisibilityImportRow | null> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query<AiVisibilityImportRow>(
      `SELECT id, project_id, uploaded_by, csv_sha256, row_count, provenance,
              epistemic_class, unverified_by_provider, created_at
         FROM ai_visibility_imports
        WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
      [organizationId, projectId, importId],
    );
    return res.rows[0] ?? null;
  });
}

export async function listAiVisibilityCaptures(
  organizationId: string,
  projectId: string,
  importId: string,
): Promise<AiVisibilityCaptureRow[]> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query<AiVisibilityCaptureRow>(
      `SELECT id, import_id, row_number, engine, prompt_id, brand_mentioned,
              client_cited, citation_domains, sampled_at
         FROM ai_visibility_captures
        WHERE organization_id = $1 AND project_id = $2 AND import_id = $3
        ORDER BY row_number`,
      [organizationId, projectId, importId],
    );
    return res.rows;
  });
}

/** Aggregate rates from persisted captures, optionally scoped to one import. */
export async function listAiVisibilityStats(
  organizationId: string,
  projectId: string,
  importId: string,
): Promise<AiVisibilityStat[]> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query<AiVisibilityStatsDbRow>(
      `WITH selected AS (
         SELECT engine, prompt_id, brand_mentioned, client_cited, citation_domains
           FROM ai_visibility_captures
          WHERE organization_id = $1 AND project_id = $2 AND import_id = $3
       ), capture_stats AS (
         SELECT engine, prompt_id, count(*)::int AS runs,
                count(*) FILTER (WHERE brand_mentioned)::int AS mention_count,
                count(*) FILTER (WHERE client_cited)::int AS citation_count,
                count(*) OVER (PARTITION BY engine)::int AS prompts_observed
           FROM selected
          GROUP BY engine, prompt_id
       ), domain_counts AS (
         SELECT engine, prompt_id, domain, count(*)::int AS domain_count
           FROM selected
           CROSS JOIN LATERAL unnest(citation_domains) AS d(domain)
          GROUP BY engine, prompt_id, d.domain
       ), ranked_domains AS (
         SELECT engine, prompt_id, domain, domain_count,
                row_number() OVER (
                  PARTITION BY engine, prompt_id ORDER BY domain_count DESC, domain
                ) AS domain_rank
           FROM domain_counts
       ), domain_stats AS (
         SELECT engine, prompt_id, count(*)::int AS unique_citation_domains,
                jsonb_agg(jsonb_build_array(domain, domain_count)
                          ORDER BY domain_count DESC, domain)
                  FILTER (WHERE domain_rank <= 10) AS top_citation_domains
           FROM ranked_domains
          GROUP BY engine, prompt_id
       )
       SELECT capture_stats.engine, capture_stats.prompt_id,
              capture_stats.prompts_observed,
              capture_stats.runs, capture_stats.mention_count,
              capture_stats.citation_count,
              capture_stats.mention_count::float8 / capture_stats.runs AS mention_rate,
              capture_stats.citation_count::float8 / capture_stats.runs AS citation_rate,
              COALESCE(domain_stats.unique_citation_domains, 0)::int AS unique_citation_domains,
              COALESCE(domain_stats.top_citation_domains, '[]'::jsonb) AS top_citation_domains
         FROM capture_stats
         LEFT JOIN domain_stats USING (engine, prompt_id)
        ORDER BY capture_stats.engine, capture_stats.prompt_id`,
      [organizationId, projectId, importId],
    );
    return res.rows.map((row) => ({
      engine: row.engine,
      promptId: row.prompt_id,
      promptsObserved: row.prompts_observed,
      runs: row.runs,
      mentionCount: row.mention_count,
      citationCount: row.citation_count,
      mentionRate: row.mention_rate,
      mentionWilson95: wilsonInterval95(row.mention_count, row.runs),
      citationRate: row.citation_rate,
      citationWilson95: wilsonInterval95(row.citation_count, row.runs),
      uniqueCitationDomains: row.unique_citation_domains,
      topCitationDomains: row.top_citation_domains ?? [],
    }));
  });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
