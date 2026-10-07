export interface ProjectCreationPayload {
  organizationId: string;
  name: string;
  primaryDomain: string;
}

export interface PendingProjectCreation extends ProjectCreationPayload {
  idempotencyKey: string;
}

export type ProjectDomainResult =
  { ok: true; primaryDomain: string } | { ok: false; message: string };

/** A project represents a site origin; page-level audits accept full URLs elsewhere. */
export function normalizeProjectDomain(value: string): ProjectDomainResult {
  const input = value.trim();
  if (!input) return { ok: false, message: "Enter the domain of the site you want to audit." };
  if (input.length > 2_048) return { ok: false, message: "The address is too long." };
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input) && !/^https?:\/\//i.test(input)) {
    return { ok: false, message: "Only public HTTP and HTTPS site addresses are supported." };
  }

  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search
    ) {
      return {
        ok: false,
        message: "Enter a site domain or homepage URL without a page path or query string.",
      };
    }
    if (!url.hostname || url.host.length > 253) {
      return { ok: false, message: "Enter a valid site domain." };
    }
    return { ok: true, primaryDomain: url.host.toLowerCase() };
  } catch {
    return { ok: false, message: "Enter a valid HTTP(S) site address." };
  }
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
