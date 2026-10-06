import { withTenant } from "./client.ts";

export interface PersistedPatch {
  id: string;
  organizationId: string;
  projectId: string;
  findingId: string;
  version: number;
  status: string;
  contentHash: string;
  proposal: Record<string, unknown>;
  fixtureHtml: string;
  eventCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PatchEventInput {
  from: string | null;
  to: string;
  actor: string;
  at: string;
  reason: string;
  contentHash: string;
}

interface PatchRow {
  id: string;
  organization_id: string;
  project_id: string;
  finding_id: string;
  status: string;
  version: number;
  content_hash: string;
  proposal_json: Record<string, unknown>;
  events_json?: unknown;
  fixture_html: string;
  event_count: number;
  created_at: Date;
  updated_at: Date;
}

function mapPatch(row: PatchRow): PersistedPatch {
  const events = Array.isArray(row.events_json) ? row.events_json : [];
  if (events.length !== row.event_count) {
    throw new Error("Patch event ledger integrity check failed.");
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    findingId: row.finding_id,
    version: row.version,
    status: row.status,
    contentHash: row.content_hash,
    proposal: { ...row.proposal_json, events },
    fixtureHtml: row.fixture_html,
    eventCount: row.event_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function proposalSnapshot(proposal: Record<string, unknown>): Record<string, unknown> {
  const { events: _events, ...snapshot } = proposal;
  return snapshot;
}

const PATCH_SELECT = `
  SELECT p.id, p.organization_id, p.project_id, p.finding_id, p.status,
         p.version, p.content_hash, p.proposal_json, p.fixture_html,
         p.event_count, p.created_at, p.updated_at,
         COALESCE((
           SELECT jsonb_agg(e.event_json ORDER BY e.event_number)
             FROM patch_events e
            WHERE e.organization_id = p.organization_id AND e.patch_id = p.id
         ), '[]'::jsonb) AS events_json
    FROM patch_proposals p
`;

function actorUserId(actor: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actor)
    ? actor
    : null;
}

async function appendEvents(
  client: import("pg").PoolClient,
  organizationId: string,
  patchId: string,
  firstNumber: number,
  events: readonly PatchEventInput[],
): Promise<void> {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event) continue;
    await client.query(
      `INSERT INTO patch_events
         (organization_id, patch_id, event_number, actor_user_id, event_json, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        organizationId,
        patchId,
        firstNumber + index + 1,
        actorUserId(event.actor),
        JSON.stringify(event),
        event.at,
      ],
    );
  }
}

export async function createPatch(input: {
  organizationId: string;
  projectId: string;
  findingId: string;
  createdBy: string;
  proposal: Record<string, unknown>;
  fixtureHtml: string;
  events: readonly PatchEventInput[];
}): Promise<PersistedPatch> {
  return withTenant(input.organizationId, async (client) => {
    const result = await client.query<PatchRow>(
      `INSERT INTO patch_proposals
         (id, organization_id, project_id, finding_id, status, version,
          content_hash, proposal_json, fixture_html, event_count, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
       RETURNING id, organization_id, project_id, finding_id, status, version,
                 content_hash, proposal_json, fixture_html, event_count, created_at, updated_at`,
      [
        input.proposal.id,
        input.organizationId,
        input.projectId,
        input.findingId,
        input.proposal.status,
        input.proposal.version,
        input.proposal.contentHash,
        JSON.stringify(proposalSnapshot(input.proposal)),
        input.fixtureHtml,
        input.events.length,
        input.createdBy,
      ],
    );
    await appendEvents(client, input.organizationId, input.proposal.id as string, 0, input.events);
    const row = result.rows[0];
    if (!row) throw new Error("Patch insert returned no row.");
    return mapPatch({ ...row, events_json: input.events });
  });
}

export async function getPatch(
  organizationId: string,
  patchId: string,
): Promise<PersistedPatch | null> {
  return withTenant(organizationId, async (client) => {
    const result = await client.query<PatchRow>(
      `${PATCH_SELECT} WHERE p.organization_id = $1 AND p.id = $2`,
      [organizationId, patchId],
    );
    const row = result.rows[0];
    return row ? mapPatch(row) : null;
  });
}

export async function listPatches(
  organizationId: string,
  projectId: string,
): Promise<PersistedPatch[]> {
  return withTenant(organizationId, async (client) => {
    const result = await client.query<PatchRow>(
      `${PATCH_SELECT}
        WHERE p.organization_id = $1 AND p.project_id = $2
        ORDER BY p.updated_at DESC, p.id`,
      [organizationId, projectId],
    );
    return result.rows.map(mapPatch);
  });
}

/**
 * Compare-and-swap the proposal and append only its new events in one tenant
 * transaction. Prior event JSON is never rewritten by the runtime role.
 */
export async function updatePatch(input: {
  organizationId: string;
  patchId: string;
  expectedVersion: number;
  proposal: Record<string, unknown>;
  fixtureHtml: string;
  events: readonly PatchEventInput[];
  previousEventCount: number;
}): Promise<boolean> {
  return withTenant(input.organizationId, async (client) => {
    const current = await client.query<PatchRow>(
      `${PATCH_SELECT}
        WHERE p.organization_id = $1 AND p.id = $2
        FOR UPDATE`,
      [input.organizationId, input.patchId],
    );
    const row = current.rows[0];
    if (row?.version !== input.expectedVersion) return false;
    if (row.event_count !== input.previousEventCount) return false;
    const result = await client.query(
      `UPDATE patch_proposals
          SET status = $3, version = $4, content_hash = $5,
              proposal_json = $6::jsonb, fixture_html = $7,
              event_count = event_count + $8, updated_at = now()
        WHERE organization_id = $1 AND id = $2 AND version = $9`,
      [
        input.organizationId,
        input.patchId,
        input.proposal.status,
        input.proposal.version,
        input.proposal.contentHash,
        JSON.stringify(proposalSnapshot(input.proposal)),
        input.fixtureHtml,
        input.events.length,
        input.expectedVersion,
      ],
    );
    if (result.rowCount !== 1) return false;
    await appendEvents(
      client,
      input.organizationId,
      input.patchId,
      input.previousEventCount,
      input.events,
    );
    return true;
  });
}
