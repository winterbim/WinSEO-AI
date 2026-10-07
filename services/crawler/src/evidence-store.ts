// ─── Evidence Store Adapter ───
// Blueprint §11.3 — S3-compatible storage for evidence objects
// Path: /{organization_id}/{project_id}/{kind}/{date}/{hash}

import { createHash, randomUUID } from "node:crypto";
import { logger } from "@serpvera/telemetry";

export interface EvidenceStoreConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
}

export interface EvidenceRecord {
  evidenceId: string;
  organizationId: string;
  projectId: string;
  kind: string;
  sourceRef: string;
  contentHash: string;
  objectKey: string;
  capturedAt: string;
  metadata?: Record<string, unknown>;
}

export interface EvidenceStore {
  store(
    record: Omit<EvidenceRecord, "evidenceId" | "contentHash" | "objectKey">,
    content: Buffer | string,
  ): Promise<EvidenceRecord>;
  retrieve(objectKey: string): Promise<Buffer | null>;
  delete(objectKey: string): Promise<void>;
}

/**
 * In-memory evidence store for tests and MVP.
 * Replace with S3 adapter when infrastructure is provisioned.
 */
export function createMemoryEvidenceStore(): EvidenceStore {
  const store = new Map<string, Buffer>();
  const records = new Map<string, EvidenceRecord>();

  return {
    store(record, content) {
      const id = randomUUID();
      const data = typeof content === "string" ? Buffer.from(content) : content;
      const hash = createHash("sha256").update(data).digest("hex");
      const date = new Date().toISOString().slice(0, 10);
      const key = `${record.organizationId}/${record.projectId}/${record.kind}/${date}/${hash}`;

      const evidenceRecord: EvidenceRecord = {
        evidenceId: id,
        organizationId: record.organizationId,
        projectId: record.projectId,
        kind: record.kind,
        sourceRef: record.sourceRef,
        contentHash: hash,
        objectKey: key,
        capturedAt: record.capturedAt,
        metadata: record.metadata,
      };

      store.set(key, data);
      records.set(id, evidenceRecord);

      logger.debug("Evidence stored", {
        evidenceId: id,
        kind: record.kind,
        bytes: data.length,
      });

      // Deliberately synchronous under an async interface: the in-memory
      // driver has nothing to await, so it returns resolved promises
      // directly instead of carrying a hollow `async` keyword.
      return Promise.resolve(evidenceRecord);
    },

    retrieve(key) {
      return Promise.resolve(store.get(key) ?? null);
    },

    delete(key) {
      store.delete(key);
      return Promise.resolve();
    },
  };
}
