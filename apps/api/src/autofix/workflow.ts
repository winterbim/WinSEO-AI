import { createHash, randomUUID } from "node:crypto";

export type PatchRisk = "R0" | "R1";
export type PatchField = "title" | "image_alt";
export type PatchStatus =
  | "detected"
  | "proposed"
  | "previewed"
  | "approved"
  | "deploying"
  | "deployed"
  | "deployed_manually"
  | "live_verified"
  | "google_observed"
  | "measuring"
  | "measured"
  | "drifted"
  | "rolled_back"
  | "failed"
  | "rejected"
  | "superseded";

export const PATCH_TRANSITIONS: Record<PatchStatus, readonly PatchStatus[]> = {
  detected: ["proposed", "rejected"],
  proposed: ["previewed", "rejected", "superseded"],
  previewed: ["proposed", "approved", "rejected", "superseded"],
  approved: ["deploying", "deployed_manually", "proposed", "rejected", "superseded"],
  deploying: ["deployed", "failed", "rolled_back"],
  deployed: ["live_verified", "failed", "rolled_back", "superseded"],
  deployed_manually: ["live_verified", "failed", "rolled_back", "superseded"],
  live_verified: ["google_observed", "rolled_back", "superseded", "drifted"],
  google_observed: ["measuring", "rolled_back", "superseded", "drifted"],
  measuring: ["measured", "rolled_back", "superseded", "drifted"],
  measured: ["rolled_back", "superseded", "drifted"],
  drifted: ["superseded"],
  rolled_back: [],
  failed: ["rolled_back", "superseded"],
  rejected: [],
  superseded: [],
};

export interface PatchEvidence {
  url: string;
  capturedAt: string;
  rawHtml: string;
  contentHash: string;
  visibleText: string;
  visualReview?: { role: "informative" | "decorative"; description?: string };
}

export interface PatchChange {
  field: PatchField;
  before: string | null;
  after: string;
  imageId?: string;
  imageRole?: "informative" | "decorative";
}

export interface PatchActor {
  organizationId: string;
  userId: string;
  email: string;
}

const stepUpBrand = Symbol("server-verified-step-up");
export interface StepUpProof {
  actorId: string;
  verifiedAt: string;
  readonly [stepUpBrand]: true;
}

/** Test-only issuer. JSON/API callers cannot create the private runtime brand. */
export function fixtureStepUpProof(
  actorId: string,
  verifiedAt = new Date().toISOString(),
): StepUpProof {
  if (process.env.NODE_ENV === "production") {
    throw new PatchWorkflowError(
      "FIXTURE_ONLY",
      "Fixture step-up proofs are disabled in production.",
    );
  }
  return { actorId, verifiedAt, [stepUpBrand]: true };
}

/** Internal API helper. Call only after the MFA store atomically consumes a TOTP counter. */
export function serverVerifiedStepUpProof(
  actorId: string,
  verifiedAt = new Date().toISOString(),
): StepUpProof {
  return { actorId, verifiedAt, [stepUpBrand]: true };
}

function isStepUpProof(value: unknown): value is StepUpProof {
  return typeof value === "object" && value !== null && Reflect.get(value, stepUpBrand) === true;
}

export interface PatchEvent {
  from: PatchStatus | null;
  to: PatchStatus;
  at: string;
  actor: string;
  reason: string;
  contentHash: string;
}

export interface PatchProposal {
  id: string;
  organizationId: string;
  projectId: string;
  findingId: string;
  field: PatchField;
  risk: PatchRisk;
  url: string;
  evidence: PatchEvidence;
  change: PatchChange;
  contentHash: string;
  status: PatchStatus;
  version: number;
  preview: {
    mode: "simulated";
    contentHash: string;
    beforeHtml: string;
    afterHtml: string;
  } | null;
  approval: { actor: string; at: string; contentHash: string } | null;
  deployment: {
    mode: "fixture" | "manual";
    at: string;
    receiptHash: string | null;
    rollbackDryRunHash: string | null;
    instructions?: string;
  } | null;
  verification: PatchVerification | null;
  verifications: PatchVerification[];
  events: PatchEvent[];
}

export interface Observation {
  userAgent: "browser" | "googlebot";
  mode: "raw" | "rendered";
  observedAt: string;
  status: number;
  contentType: string;
  value: string | null;
  occurrences: number;
  contentHash: string | null;
}

export interface PatchVerification {
  at: string;
  verdict: "pass" | "fail" | "inconclusive";
  observations: Observation[];
}

export interface PreviewResult {
  mode: "simulated";
  contentHash: string;
  beforeValue: string | null;
  afterValue: string;
  beforeHtml: string;
  afterHtml: string;
  risk: PatchRisk;
  rollbackValue: string | null;
}

export interface FixturePageAdapter {
  readonly kind: "fixture";
  read(
    url: string,
    userAgent: "browser" | "googlebot",
    mode: "raw" | "rendered",
  ): Promise<{
    status: number;
    contentType: string;
    html: string;
    observedAt: string;
  }>;
  write(
    url: string,
    html: string,
    expectedHash: string,
    idempotencyKey: string,
  ): Promise<{ contentHash: string; idempotentReplay: boolean }>;
  pageUrls(): string[];
}

export class PatchWorkflowError extends Error {
  readonly code:
    | "FIXTURE_ONLY"
    | "EVIDENCE_MISMATCH"
    | "PATCH_UNSUPPORTED"
    | "PATCH_UNGROUNDED"
    | "PATCH_CONFLICT"
    | "PATCH_NOT_FOUND"
    | "TENANT_MISMATCH"
    | "INVALID_TRANSITION"
    | "APPROVAL_HASH_MISMATCH"
    | "STEP_UP_REQUIRED"
    | "ROLLBACK_NOT_READY"
    | "SOURCE_CHANGED"
    | "VERIFICATION_FAILED";

  constructor(code: PatchWorkflowError["code"], message: string) {
    super(message);
    this.name = "PatchWorkflowError";
    this.code = code;
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`)
    .join(",")}}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashContent(value: unknown): string {
  return sha256(canonical(value));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function countMatches(value: string, expression: RegExp): number {
  return [...value.matchAll(expression)].length;
}

export function inspectPatchTarget(
  html: string,
  field: PatchField,
  imageId?: string,
): { value: string | null; count: number } {
  if (field === "title") {
    const tags = [...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)];
    return {
      value: tags.length === 1 ? decodeHtml(tags[0]?.[1]?.trim() ?? "") : null,
      count: tags.length,
    };
  }
  if (!imageId) return { value: null, count: 0 };
  const images = [...html.matchAll(/<img\b[^>]*>/gi)].filter((match) => {
    const idAttribute = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[0]);
    return (idAttribute?.[1] ?? idAttribute?.[2]) === imageId;
  });
  if (images.length !== 1) return { value: null, count: images.length };
  const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(images[0]?.[0] ?? "");
  return {
    value: alt ? decodeHtml(alt[1] ?? alt[2] ?? alt[3] ?? "") : null,
    count: 1,
  };
}

function targetValue(html: string, change: PatchChange): { value: string | null; count: number } {
  return inspectPatchTarget(html, change.field, change.imageId);
}

function patchHtml(html: string, change: PatchChange): string {
  if (change.field === "title") {
    if (countMatches(html, /<title\b[^>]*>[\s\S]*?<\/title>/gi) !== 1) {
      throw new PatchWorkflowError(
        "PATCH_CONFLICT",
        "The page must contain exactly one title element.",
      );
    }
    return html.replace(
      /(<title\b[^>]*>)[\s\S]*?(<\/title>)/i,
      (_full, open: string, close: string) => `${open}${escapeHtml(change.after)}${close}`,
    );
  }
  if (!change.imageId || targetValue(html, change).count !== 1) {
    throw new PatchWorkflowError(
      "PATCH_CONFLICT",
      "The image selector must match exactly one image.",
    );
  }
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const idAttribute = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if ((idAttribute?.[1] ?? idAttribute?.[2]) !== change.imageId) return tag;
    const encoded = escapeHtml(change.after);
    if (/\balt\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(tag)) {
      return tag.replace(/\balt\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, () => `alt="${encoded}"`);
    }
    return tag.replace(/\s*\/?\s*>$/, (ending) => ` alt="${encoded}"${ending}`);
  });
}

function rollbackHtml(html: string, change: PatchChange): string {
  if (change.field !== "image_alt" || change.before !== null) {
    return patchHtml(html, { ...change, after: change.before ?? "" });
  }
  if (!change.imageId || targetValue(html, change).count !== 1) {
    throw new PatchWorkflowError(
      "PATCH_CONFLICT",
      "The image selector must match exactly one image for rollback.",
    );
  }
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const idAttribute = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if ((idAttribute?.[1] ?? idAttribute?.[2]) !== change.imageId) return tag;
    return tag.replace(/\s+alt\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "");
  });
}

function normalizedWords(value: string): string[] {
  return (
    value
      .toLocaleLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .match(/[a-z0-9]{3,}/g) ?? []
  );
}

function validateChange(evidence: PatchEvidence, change: PatchChange): PatchRisk {
  const field = (change as { field: string }).field;
  if (field !== "title" && field !== "image_alt") {
    throw new PatchWorkflowError(
      "PATCH_UNSUPPORTED",
      "This patch type is not allowed by the R0/R1 policy.",
    );
  }
  const url = new URL(evidence.url);
  if (url.protocol !== "https:") {
    throw new PatchWorkflowError("EVIDENCE_MISMATCH", "Patch evidence must use HTTPS.");
  }
  if (sha256(evidence.rawHtml) !== evidence.contentHash) {
    throw new PatchWorkflowError(
      "EVIDENCE_MISMATCH",
      "The evidence hash does not match its HTML snapshot.",
    );
  }
  const capturedAt = Date.parse(evidence.capturedAt);
  if (
    !Number.isFinite(capturedAt) ||
    capturedAt > Date.now() + 5_000 ||
    Date.now() - capturedAt > 15 * 60_000
  ) {
    throw new PatchWorkflowError(
      "EVIDENCE_MISMATCH",
      "Patch evidence must be recent and timestamped.",
    );
  }
  if (change.field === "image_alt") {
    if (!change.imageId || !evidence.visualReview) {
      throw new PatchWorkflowError(
        "PATCH_UNGROUNDED",
        "An alt patch requires a stable image id and visual review.",
      );
    }
    if (change.imageRole !== evidence.visualReview.role) {
      throw new PatchWorkflowError(
        "PATCH_UNGROUNDED",
        "The proposed image role must match the reviewed role.",
      );
    }
    if (change.imageRole === "decorative" && change.after !== "") {
      throw new PatchWorkflowError(
        "PATCH_UNGROUNDED",
        "A decorative image must have an empty alt value.",
      );
    }
    if (change.imageRole === "informative") {
      const description = evidence.visualReview.description?.trim();
      const supportedWords = new Set(
        normalizedWords(`${description ?? ""} ${evidence.visibleText}`),
      );
      const proposedWords = normalizedWords(change.after);
      if (
        !description ||
        proposedWords.length === 0 ||
        proposedWords.some((word) => !supportedWords.has(word))
      ) {
        throw new PatchWorkflowError(
          "PATCH_UNGROUNDED",
          "The informative alt must use only words supported by the visual review and visible page text.",
        );
      }
    }
    return "R0";
  }
  const title = change.after.trim();
  const words = normalizedWords(title);
  const unique = new Set(words);
  const pageWords = new Set(normalizedWords(evidence.visibleText));
  if (
    title.length < 5 ||
    title.length > 120 ||
    words.length < 2 ||
    unique.size !== words.length ||
    words.some((word) => !pageWords.has(word))
  ) {
    throw new PatchWorkflowError(
      "PATCH_UNGROUNDED",
      "The title must be concise, use unique terms, and be grounded in visible page text.",
    );
  }
  return "R1";
}

function cloneProposal(proposal: PatchProposal): PatchProposal {
  return structuredClone(proposal);
}

export class ProvenPatchWorkflow {
  readonly executionMode = "fixture" as const;
  readonly #records = new Map<string, PatchProposal>();
  readonly adapter: FixturePageAdapter;
  private readonly clock: () => Date;

  constructor(adapter: FixturePageAdapter, clock: () => Date = () => new Date()) {
    this.adapter = adapter;
    this.clock = clock;
    if (process.env.NODE_ENV === "production") {
      throw new PatchWorkflowError(
        "FIXTURE_ONLY",
        "The fixture patch workflow is disabled in production.",
      );
    }
  }

  async propose(input: {
    organizationId: string;
    projectId: string;
    findingId: string;
    evidence: PatchEvidence;
    change: PatchChange;
  }): Promise<PatchProposal> {
    const risk = validateChange(input.evidence, input.change);
    const current = await this.adapter.read(input.evidence.url, "browser", "raw");
    if (current.status !== 200 || current.html !== input.evidence.rawHtml) {
      throw new PatchWorkflowError(
        "EVIDENCE_MISMATCH",
        "The live fixture no longer matches the captured evidence.",
      );
    }
    const observed = targetValue(current.html, input.change);
    if (observed.count !== 1 || observed.value !== input.change.before) {
      throw new PatchWorkflowError(
        "EVIDENCE_MISMATCH",
        "The target value does not match the evidence snapshot exactly once.",
      );
    }
    const id = randomUUID();
    const contentHash = hashContent({
      organizationId: input.organizationId,
      projectId: input.projectId,
      findingId: input.findingId,
      url: input.evidence.url,
      evidenceHash: input.evidence.contentHash,
      evidenceContextHash: hashContent({
        capturedAt: input.evidence.capturedAt,
        visibleText: input.evidence.visibleText,
        visualReview: input.evidence.visualReview ?? null,
      }),
      risk,
      change: input.change,
    });
    const record: PatchProposal = {
      id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      findingId: input.findingId,
      field: input.change.field,
      risk,
      url: input.evidence.url,
      evidence: structuredClone(input.evidence),
      change: structuredClone(input.change),
      contentHash,
      status: "proposed",
      version: 1,
      preview: null,
      approval: null,
      deployment: null,
      verification: null,
      verifications: [],
      events: [],
    };
    this.#records.set(id, record);
    this.#event(record, null, "detected", "system", "Evidence-backed finding received.");
    this.#event(record, "detected", "proposed", "system", "Policy accepted a single R0/R1 patch.");
    return cloneProposal(record);
  }

  /** Rehydrate a server-persisted proposal and validate its immutable content hash. */
  restore(proposal: PatchProposal): void {
    if (
      typeof proposal.id !== "string" ||
      typeof proposal.organizationId !== "string" ||
      typeof proposal.projectId !== "string" ||
      typeof proposal.findingId !== "string" ||
      !Object.hasOwn(PATCH_TRANSITIONS, proposal.status) ||
      !Array.isArray(proposal.events) ||
      !Array.isArray(proposal.verifications)
    ) {
      throw new PatchWorkflowError("PATCH_CONFLICT", "Stored patch record is malformed.");
    }
    const expectedHash = hashContent({
      organizationId: proposal.organizationId,
      projectId: proposal.projectId,
      findingId: proposal.findingId,
      url: proposal.evidence.url,
      evidenceHash: proposal.evidence.contentHash,
      evidenceContextHash: hashContent({
        capturedAt: proposal.evidence.capturedAt,
        visibleText: proposal.evidence.visibleText,
        visualReview: proposal.evidence.visualReview ?? null,
      }),
      risk: proposal.risk,
      change: proposal.change,
    });
    if (
      expectedHash !== proposal.contentHash ||
      proposal.events.some((event) => event.contentHash !== proposal.contentHash) ||
      proposal.events.at(-1)?.to !== proposal.status
    ) {
      throw new PatchWorkflowError("PATCH_CONFLICT", "Stored patch integrity check failed.");
    }
    this.#records.set(proposal.id, structuredClone(proposal));
  }

  get(organizationId: string, patchId: string): PatchProposal {
    const record = this.#records.get(patchId);
    if (!record) throw new PatchWorkflowError("PATCH_NOT_FOUND", "Patch not found.");
    if (record.organizationId !== organizationId) {
      throw new PatchWorkflowError("TENANT_MISMATCH", "Patch not found.");
    }
    return cloneProposal(record);
  }

  async preview(organizationId: string, patchId: string): Promise<PreviewResult> {
    const record = this.#record(organizationId, patchId);
    this.#expect(record, ["proposed"]);
    const current = await this.adapter.read(record.url, "browser", "raw");
    if (current.status !== 200 || sha256(current.html) !== record.evidence.contentHash) {
      throw new PatchWorkflowError(
        "SOURCE_CHANGED",
        "The fixture changed after evidence capture; create a new finding.",
      );
    }
    const afterHtml = patchHtml(current.html, record.change);
    const afterValue = targetValue(afterHtml, record.change);
    if (afterValue.count !== 1 || afterValue.value !== record.change.after) {
      throw new PatchWorkflowError(
        "PATCH_CONFLICT",
        "The preview did not produce exactly one expected value.",
      );
    }
    record.preview = {
      mode: "simulated",
      contentHash: record.contentHash,
      beforeHtml: current.html,
      afterHtml,
    };
    this.#transition(record, "previewed", "Preview was generated from a fresh fixture copy.");
    record.version += 1;
    return {
      mode: "simulated",
      contentHash: record.contentHash,
      beforeValue: record.change.before,
      afterValue: record.change.after,
      beforeHtml: current.html,
      afterHtml,
      risk: record.risk,
      rollbackValue: record.change.before,
    };
  }

  approve(
    organizationId: string,
    patchId: string,
    actor: PatchActor,
    approvedHash: string,
  ): PatchProposal {
    const record = this.#record(organizationId, patchId);
    this.#expect(record, ["previewed"]);
    if (actor.organizationId !== organizationId) {
      throw new PatchWorkflowError("TENANT_MISMATCH", "Patch not found.");
    }
    if (approvedHash !== record.contentHash) {
      throw new PatchWorkflowError(
        "APPROVAL_HASH_MISMATCH",
        "Approval must match the exact previewed patch hash.",
      );
    }
    record.approval = {
      actor: actor.userId,
      at: this.clock().toISOString(),
      contentHash: approvedHash,
    };
    this.#transition(record, "approved", "Human approved the exact preview hash.", actor.userId);
    record.version += 1;
    return cloneProposal(record);
  }

  async deploy(
    organizationId: string,
    patchId: string,
    actor: PatchActor,
    stepUpProof: StepUpProof,
  ): Promise<PatchProposal> {
    const record = this.#record(organizationId, patchId);
    this.#expect(record, ["approved"]);
    if (actor.organizationId !== organizationId) {
      throw new PatchWorkflowError("TENANT_MISMATCH", "Patch not found.");
    }
    this.#assertStepUp(actor, stepUpProof);
    if (record.approval?.contentHash !== record.contentHash) {
      throw new PatchWorkflowError(
        "APPROVAL_HASH_MISMATCH",
        "The approved hash no longer matches the patch.",
      );
    }
    if (record.preview?.contentHash !== record.contentHash) {
      throw new PatchWorkflowError(
        "ROLLBACK_NOT_READY",
        "The exact patch has no current preview or rollback snapshot.",
      );
    }
    const current = await this.adapter.read(record.url, "browser", "raw");
    if (current.status !== 200 || current.html !== record.preview.beforeHtml) {
      this.#transition(
        record,
        "superseded",
        "Source changed after approval; deployment was blocked.",
        actor.userId,
      );
      record.version += 1;
      throw new PatchWorkflowError(
        "SOURCE_CHANGED",
        "The source changed after approval. Review a new preview.",
      );
    }
    const dryRun = patchHtml(current.html, record.change);
    const restored = rollbackHtml(dryRun, record.change);
    if (restored !== current.html) {
      throw new PatchWorkflowError(
        "ROLLBACK_NOT_READY",
        "Rollback dry-run does not restore the captured source hash.",
      );
    }
    record.deployment = {
      mode: "fixture",
      at: this.clock().toISOString(),
      receiptHash: null,
      rollbackDryRunHash: sha256(restored),
    };
    this.#transition(record, "deploying", "Approval and rollback dry-run verified.", actor.userId);
    record.version += 1;
    try {
      const receipt = await this.adapter.write(record.url, dryRun, sha256(current.html), record.id);
      record.deployment.receiptHash = receipt.contentHash;
      this.#transition(
        record,
        "deployed",
        "Fixture adapter confirmed an idempotent write receipt.",
        actor.userId,
      );
      record.version += 1;
    } catch (error) {
      this.#transition(
        record,
        "failed",
        "Fixture adapter refused or failed the write.",
        actor.userId,
      );
      record.version += 1;
      throw error;
    }
    return cloneProposal(record);
  }

  async deployManually(
    organizationId: string,
    patchId: string,
    actor: PatchActor,
    stepUpProof: StepUpProof,
  ): Promise<PatchProposal> {
    const record = this.#record(organizationId, patchId);
    this.#expect(record, ["approved"]);
    if (actor.organizationId !== organizationId) {
      throw new PatchWorkflowError("TENANT_MISMATCH", "Patch not found.");
    }
    this.#assertStepUp(actor, stepUpProof);
    if (record.approval?.contentHash !== record.contentHash) {
      throw new PatchWorkflowError(
        "APPROVAL_HASH_MISMATCH",
        "The approved hash no longer matches the patch.",
      );
    }
    if (record.preview?.contentHash !== record.contentHash) {
      throw new PatchWorkflowError(
        "ROLLBACK_NOT_READY",
        "The exact patch has no current preview or rollback snapshot.",
      );
    }
    const current = await this.adapter.read(record.url, "browser", "raw");
    if (current.status !== 200 || current.html !== record.preview.beforeHtml) {
      this.#transition(
        record,
        "superseded",
        "Source changed after approval; manual instructions were withdrawn.",
        actor.userId,
      );
      record.version += 1;
      throw new PatchWorkflowError(
        "SOURCE_CHANGED",
        "The source changed after approval. Review a new preview.",
      );
    }
    const rollbackDryRun = rollbackHtml(record.preview.afterHtml, record.change);
    if (rollbackDryRun !== record.preview.beforeHtml) {
      throw new PatchWorkflowError(
        "ROLLBACK_NOT_READY",
        "Manual rollback instructions do not restore the captured source hash.",
      );
    }
    record.deployment = {
      mode: "manual",
      at: this.clock().toISOString(),
      receiptHash: null,
      rollbackDryRunHash: sha256(rollbackDryRun),
      instructions: `Set ${record.change.field} on ${record.url} to ${JSON.stringify(record.change.after)}; then run live verification. This is a manual declaration, not a platform write receipt.`,
    };
    this.#transition(
      record,
      "deployed_manually",
      "Manual instructions issued; no platform write is claimed.",
      actor.userId,
    );
    record.version += 1;
    return cloneProposal(record);
  }

  async verify(organizationId: string, patchId: string): Promise<PatchProposal> {
    const record = this.#record(organizationId, patchId);
    this.#expect(record, ["deployed", "deployed_manually"]);
    const observations: Observation[] = [];
    for (const userAgent of ["browser", "googlebot"] as const) {
      for (const mode of ["raw", "rendered"] as const) {
        const response = await this.adapter.read(record.url, userAgent, mode);
        const target = targetValue(response.html, record.change);
        observations.push({
          userAgent,
          mode,
          observedAt: response.observedAt,
          status: response.status,
          contentType: response.contentType,
          value: target.value,
          occurrences: target.count,
          contentHash: response.status === 200 ? sha256(response.html) : null,
        });
      }
    }
    const blocked = observations.some(
      (item) => item.status !== 200 || !item.contentType.includes("text/html"),
    );
    const values = observations.map((item) => item.value);
    const exact = observations.every(
      (item) =>
        item.status === 200 &&
        item.contentType.includes("text/html") &&
        item.occurrences === 1 &&
        item.value === record.change.after,
    );
    const postDeployment =
      record.deployment !== null &&
      observations.every(
        (item) => Date.parse(item.observedAt) > Date.parse(record.deployment?.at ?? ""),
      );
    const parity = new Set(values).size === 1;
    const noCollateral = record.preview
      ? observations.every((item) => item.contentHash === sha256(record.preview?.afterHtml ?? ""))
      : false;
    const verdict = blocked
      ? "inconclusive"
      : exact && parity && noCollateral && postDeployment
        ? "pass"
        : "fail";
    record.verification = {
      at: this.clock().toISOString(),
      verdict,
      observations,
    };
    record.verifications.push(structuredClone(record.verification));
    if (verdict === "pass") {
      this.#transition(
        record,
        "live_verified",
        "Post-deployment raw/rendered and user-agent checks passed.",
      );
      record.version += 1;
      return cloneProposal(record);
    }
    if (record.status === "deployed_manually") {
      // A manual declaration has no write receipt. A failed first recrawl means
      // the change is not visible yet; keep it pending and allow a later retry.
      record.verification.verdict = blocked ? "inconclusive" : "fail";
      record.verifications[record.verifications.length - 1] = structuredClone(record.verification);
      record.version += 1;
      return cloneProposal(record);
    }
    this.#transition(
      record,
      "failed",
      blocked
        ? "Verification was blocked; a blocked response is not success."
        : "Live value, parity, or collateral check failed.",
    );
    record.version += 1;
    if (record.deployment?.mode === "fixture")
      await this.rollback(organizationId, patchId, { automatic: true });
    throw new PatchWorkflowError(
      blocked ? "VERIFICATION_FAILED" : "VERIFICATION_FAILED",
      `Live verification ${verdict}; observed evidence is attached to the patch record.`,
    );
  }

  async rollback(
    organizationId: string,
    patchId: string,
    options: { automatic?: boolean } = {},
  ): Promise<PatchProposal> {
    const record = this.#record(organizationId, patchId);
    this.#expect(record, ["deployed", "live_verified", "failed"]);
    if (!record.preview || !record.deployment?.rollbackDryRunHash) {
      throw new PatchWorkflowError(
        "ROLLBACK_NOT_READY",
        "No verified before snapshot is available.",
      );
    }
    const current = await this.adapter.read(record.url, "browser", "raw");
    if (current.status !== 200 || current.html !== record.preview.afterHtml) {
      this.#transition(
        record,
        "superseded",
        "The source changed after deployment; rollback refused to overwrite it.",
      );
      record.version += 1;
      throw new PatchWorkflowError(
        "SOURCE_CHANGED",
        "A newer source edit exists; rollback was blocked to protect it.",
      );
    }
    await this.adapter.write(
      record.url,
      record.preview.beforeHtml,
      sha256(current.html),
      `${record.id}:rollback`,
    );
    const observations: Observation[] = [];
    for (const userAgent of ["browser", "googlebot"] as const) {
      for (const mode of ["raw", "rendered"] as const) {
        const response = await this.adapter.read(record.url, userAgent, mode);
        const target = targetValue(response.html, record.change);
        observations.push({
          userAgent,
          mode,
          observedAt: response.observedAt,
          status: response.status,
          contentType: response.contentType,
          value: target.value,
          occurrences: target.count,
          contentHash: response.status === 200 ? sha256(response.html) : null,
        });
      }
    }
    const rollbackVerified = observations.every(
      (item) =>
        item.status === 200 &&
        item.contentType.includes("text/html") &&
        item.occurrences === 1 &&
        item.value === record.change.before &&
        item.contentHash === record.evidence.contentHash,
    );
    record.verification = {
      at: this.clock().toISOString(),
      verdict: rollbackVerified ? "pass" : "fail",
      observations,
    };
    record.verifications.push(structuredClone(record.verification));
    if (!rollbackVerified) {
      if (record.status !== "failed") {
        this.#transition(
          record,
          "failed",
          "Rollback was written but its online verification failed.",
        );
        record.version += 1;
      }
      throw new PatchWorkflowError(
        "VERIFICATION_FAILED",
        "Rollback is not reported complete until the initial hash is observed.",
      );
    }
    this.#transition(
      record,
      "rolled_back",
      options.automatic
        ? "Automatic safety rollback was verified online."
        : "Human requested rollback; the initial page hash was verified online.",
    );
    record.version += 1;
    return cloneProposal(record);
  }

  #record(organizationId: string, patchId: string): PatchProposal {
    const record = this.#records.get(patchId);
    if (!record) throw new PatchWorkflowError("PATCH_NOT_FOUND", "Patch not found.");
    if (record.organizationId !== organizationId) {
      throw new PatchWorkflowError("TENANT_MISMATCH", "Patch not found.");
    }
    return record;
  }

  #expect(record: PatchProposal, allowed: readonly PatchStatus[]): void {
    if (!allowed.includes(record.status)) {
      throw new PatchWorkflowError(
        "INVALID_TRANSITION",
        `Operation is not allowed from ${record.status}.`,
      );
    }
  }

  #assertStepUp(actor: PatchActor, proof: StepUpProof | null): void {
    // Step-up freshness is an authentication decision, so it must use wall-clock
    // time. The injected workflow clock can intentionally advance fixture event
    // timestamps and must not make a freshly verified MFA code look expired or
    // future-dated.
    const now = Date.now();
    const issuedAt = proof ? Date.parse(proof.verifiedAt) : Number.NaN;
    if (
      !isStepUpProof(proof) ||
      proof.actorId !== actor.userId ||
      !Number.isFinite(issuedAt) ||
      issuedAt > now ||
      now - issuedAt > 5 * 60_000
    ) {
      throw new PatchWorkflowError(
        "STEP_UP_REQUIRED",
        "A fresh server-verified second factor is required to publish a patch.",
      );
    }
  }

  #transition(record: PatchProposal, to: PatchStatus, reason: string, actor = "system"): void {
    if (!PATCH_TRANSITIONS[record.status].includes(to)) {
      throw new PatchWorkflowError(
        "INVALID_TRANSITION",
        `Transition ${record.status} → ${to} is forbidden.`,
      );
    }
    const from = record.status;
    record.status = to;
    this.#event(record, from, to, actor, reason);
  }

  #event(
    record: PatchProposal,
    from: PatchStatus | null,
    to: PatchStatus,
    actor: string,
    reason: string,
  ): void {
    record.events.push({
      from,
      to,
      at: this.clock().toISOString(),
      actor,
      reason,
      contentHash: record.contentHash,
    });
  }
}

/** Deterministic, process-local CMS fixture. It has no network or production credentials. */
export class InMemoryFixtureCms implements FixturePageAdapter {
  readonly kind = "fixture" as const;
  readonly #pages: Map<string, string>;
  readonly #receipts = new Map<
    string,
    { contentHash: string; url: string; requestedHash: string }
  >();
  readonly #faults = new Map<string, { status: number; html?: string; contentType?: string }[]>();
  private readonly clock: () => Date;

  constructor(pages: Record<string, string>, clock: () => Date = () => new Date()) {
    this.clock = clock;
    this.#pages = new Map(Object.entries(pages));
  }

  seed(url: string, html: string): void {
    this.#pages.set(url, html);
  }

  injectObservation(
    url: string,
    userAgent: "browser" | "googlebot",
    mode: "raw" | "rendered",
    fault: { status: number; html?: string; contentType?: string },
  ): void {
    const key = `${url}|${userAgent}|${mode}`;
    this.#faults.set(key, [...(this.#faults.get(key) ?? []), fault]);
  }

  read(
    url: string,
    userAgent: "browser" | "googlebot",
    mode: "raw" | "rendered",
  ): Promise<{
    status: number;
    contentType: string;
    html: string;
    observedAt: string;
  }> {
    const faultKey = `${url}|${userAgent}|${mode}`;
    const fault = this.#faults.get(faultKey)?.shift();
    const html = fault?.html ?? this.#pages.get(url) ?? "";
    return Promise.resolve({
      status: fault?.status ?? (this.#pages.has(url) ? 200 : 404),
      contentType: fault?.contentType ?? "text/html; charset=utf-8",
      html,
      observedAt: this.clock().toISOString(),
    });
  }

  write(
    url: string,
    html: string,
    expectedHash: string,
    idempotencyKey: string,
  ): Promise<{ contentHash: string; idempotentReplay: boolean }> {
    const replay = this.#receipts.get(idempotencyKey);
    if (replay) {
      if (replay.url !== url || replay.requestedHash !== sha256(html)) {
        throw new PatchWorkflowError(
          "SOURCE_CHANGED",
          "An idempotency key cannot be reused for different content.",
        );
      }
      return Promise.resolve({
        contentHash: replay.contentHash,
        idempotentReplay: true,
      });
    }
    const current = this.#pages.get(url);
    if (current === undefined || sha256(current) !== expectedHash) {
      throw new PatchWorkflowError(
        "SOURCE_CHANGED",
        "Fixture source hash changed before the write.",
      );
    }
    const contentHash = sha256(html);
    this.#pages.set(url, html);
    this.#receipts.set(idempotencyKey, {
      contentHash,
      url,
      requestedHash: contentHash,
    });
    return Promise.resolve({ contentHash, idempotentReplay: false });
  }

  externalWrite(url: string, html: string): void {
    if (!this.#pages.has(url))
      throw new PatchWorkflowError("PATCH_NOT_FOUND", "Fixture page not found.");
    this.#pages.set(url, html);
  }

  pageUrls(): string[] {
    return [...this.#pages.keys()];
  }
}
