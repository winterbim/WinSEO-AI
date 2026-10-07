export interface ProjectCreationPayload {
  organizationId: string;
  name: string;
  primaryDomain: string;
}

export interface PendingProjectCreation extends ProjectCreationPayload {
  idempotencyKey: string;
}

const PENDING_PROJECT_STORAGE_KEY = "serpvera.pending-project-creation.v1";

export function readPendingProjectCreation(
  storage: Pick<Storage, "getItem">,
): PendingProjectCreation | null {
  const value = storage.getItem(PENDING_PROJECT_STORAGE_KEY);
  if (!value) return null;

  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.idempotencyKey !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        candidate.idempotencyKey,
      ) ||
      typeof candidate.organizationId !== "string" ||
      typeof candidate.name !== "string" ||
      typeof candidate.primaryDomain !== "string"
    ) {
      return null;
    }
    return {
      idempotencyKey: candidate.idempotencyKey,
      organizationId: candidate.organizationId,
      name: candidate.name,
      primaryDomain: candidate.primaryDomain,
    };
  } catch {
    return null;
  }
}

export function savePendingProjectCreation(
  storage: Pick<Storage, "setItem">,
  attempt: PendingProjectCreation,
): void {
  storage.setItem(PENDING_PROJECT_STORAGE_KEY, JSON.stringify(attempt));
}

export function clearPendingProjectCreation(storage: Pick<Storage, "removeItem">): void {
  storage.removeItem(PENDING_PROJECT_STORAGE_KEY);
}

export async function postProjectCreation(
  payload: ProjectCreationPayload,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  return fetcher("/api/v1/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
}
