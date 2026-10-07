import { createHash } from "node:crypto";

export type WordPressPatchTarget =
  | { kind: "media"; id: number; field: "alt_text" }
  | {
      kind: "post_meta";
      postType: "pages" | "posts";
      id: number;
      metaKey: string;
    };

export interface WordPressSnapshot {
  target: WordPressPatchTarget;
  value: string;
  hash: string;
  observedAt: string;
}

export interface WordPressReceipt {
  target: WordPressPatchTarget;
  beforeHash: string;
  afterHash: string;
  at: string;
  replayed: boolean;
}

export interface WordPressFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type WordPressFetch = (
  input: string,
  init: {
    method: "GET" | "OPTIONS" | "POST";
    headers: Record<string, string>;
    body?: string;
    redirect: "error";
  },
) => Promise<WordPressFetchResponse>;

export class WordPressAdapterError extends Error {
  readonly code:
    | "INVALID_CONFIGURATION"
    | "INVALID_TARGET"
    | "UNAUTHORIZED"
    | "NOT_FOUND"
    | "CAPABILITY_UNAVAILABLE"
    | "SOURCE_CHANGED"
    | "WRITE_FAILED"
    | "VERIFICATION_FAILED";

  constructor(code: WordPressAdapterError["code"], message: string) {
    super(message);
    this.name = "WordPressAdapterError";
    this.code = code;
  }
}

/** Native WordPress REST writer. API compatibility still requires a sandbox contract run. */
export class WordPressRestAdapter {
  readonly #origin: URL;
  readonly #authHeader: string;
  readonly #fetcher: WordPressFetch;
  readonly #clock: () => Date;

  constructor(
    input: { siteUrl: string; username: string; applicationPassword: string },
    fetcher: WordPressFetch = (url, init) => fetch(url, init),
    clock: () => Date = () => new Date(),
  ) {
    this.#fetcher = fetcher;
    this.#clock = clock;
    let parsed: URL;
    try {
      parsed = new URL(input.siteUrl);
    } catch {
      throw new WordPressAdapterError("INVALID_CONFIGURATION", "WordPress site URL is invalid.");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !input.username.trim() ||
      !input.applicationPassword.trim()
    ) {
      throw new WordPressAdapterError(
        "INVALID_CONFIGURATION",
        "WordPress requires an HTTPS base URL and an application credential.",
      );
    }
    this.#origin = new URL(parsed.origin);
    this.#origin.pathname = `${parsed.pathname.replace(/\/+$/, "")}/`;
    this.#authHeader = `Basic ${Buffer.from(`${input.username}:${input.applicationPassword}`).toString("base64")}`;
  }

  async read(target: WordPressPatchTarget): Promise<WordPressSnapshot> {
    const endpoint = this.#endpoint(target);
    if (target.kind === "post_meta") await this.#assertMetaWritable(endpoint, target.metaKey);
    const response = await this.#request(`${endpoint}?context=edit`, "GET");
    const json = await this.#json(response);
    const value = this.#readValue(json, target);
    return {
      target,
      value,
      hash: hashValue(value),
      observedAt: this.#clock().toISOString(),
    };
  }

  /** Checks the live source and field capability without writing. */
  async dryRun(target: WordPressPatchTarget, expectedBeforeHash: string) {
    const current = await this.read(target);
    if (current.hash !== expectedBeforeHash) {
      throw new WordPressAdapterError(
        "SOURCE_CHANGED",
        "WordPress field changed since evidence capture.",
      );
    }
    return {
      target,
      beforeHash: current.hash,
      checkedAt: current.observedAt,
      writable: true as const,
    };
  }

  /** Compare-before-write, then read-after-write. No REST response alone means success. */
  async apply(
    target: WordPressPatchTarget,
    expectedBeforeHash: string,
    afterValue: string,
  ): Promise<WordPressReceipt> {
    validateTarget(target);
    const current = await this.read(target);
    const afterHash = hashValue(afterValue);
    if (current.hash === afterHash) {
      return {
        target,
        beforeHash: expectedBeforeHash,
        afterHash,
        at: current.observedAt,
        replayed: true,
      };
    }
    if (current.hash !== expectedBeforeHash) {
      throw new WordPressAdapterError(
        "SOURCE_CHANGED",
        "WordPress field changed before publication.",
      );
    }
    await this.#writeValue(target, afterValue);
    const observed = await this.read(target);
    if (observed.hash !== afterHash) {
      throw new WordPressAdapterError(
        "VERIFICATION_FAILED",
        "WordPress did not retain the requested field value.",
      );
    }
    return {
      target,
      beforeHash: current.hash,
      afterHash,
      at: observed.observedAt,
      replayed: false,
    };
  }

  /** Refuses to roll back if a human or another system changed the field after deployment. */
  async rollback(
    target: WordPressPatchTarget,
    expectedAfterHash: string,
    beforeValue: string,
  ): Promise<WordPressReceipt> {
    const current = await this.read(target);
    const beforeHash = hashValue(beforeValue);
    if (current.hash === beforeHash) {
      return {
        target,
        beforeHash: expectedAfterHash,
        afterHash: beforeHash,
        at: current.observedAt,
        replayed: true,
      };
    }
    if (current.hash !== expectedAfterHash) {
      throw new WordPressAdapterError(
        "SOURCE_CHANGED",
        "WordPress field drifted; rollback was blocked.",
      );
    }
    await this.#writeValue(target, beforeValue);
    const observed = await this.read(target);
    if (observed.hash !== beforeHash) {
      throw new WordPressAdapterError(
        "VERIFICATION_FAILED",
        "WordPress rollback was not observed.",
      );
    }
    return {
      target,
      beforeHash: expectedAfterHash,
      afterHash: beforeHash,
      at: observed.observedAt,
      replayed: false,
    };
  }

  #endpoint(target: WordPressPatchTarget): string {
    validateTarget(target);
    const collection = target.kind === "media" ? "media" : target.postType;
    return new URL(`wp-json/wp/v2/${collection}/${target.id}`, this.#origin).toString();
  }

  async #request(
    url: string,
    method: "GET" | "OPTIONS" | "POST",
    body?: Record<string, unknown>,
  ): Promise<WordPressFetchResponse> {
    const response = await this.#fetcher(url, {
      method,
      headers: {
        authorization: this.#authHeader,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403) {
      throw new WordPressAdapterError(
        "UNAUTHORIZED",
        "WordPress rejected the application credential or capability.",
      );
    }
    if (response.status === 404) {
      throw new WordPressAdapterError("NOT_FOUND", "WordPress resource was not found.");
    }
    if (!response.ok) {
      throw new WordPressAdapterError(
        "WRITE_FAILED",
        `WordPress REST request failed (${response.status}).`,
      );
    }
    return response;
  }

  async #json(response: WordPressFetchResponse): Promise<Record<string, unknown>> {
    const data = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new WordPressAdapterError(
        "VERIFICATION_FAILED",
        "WordPress returned an invalid REST response.",
      );
    }
    return data as Record<string, unknown>;
  }

  #readValue(data: Record<string, unknown>, target: WordPressPatchTarget): string {
    if (target.kind === "media") {
      if (typeof data.alt_text !== "string") {
        throw new WordPressAdapterError(
          "CAPABILITY_UNAVAILABLE",
          "WordPress media alt_text is unavailable.",
        );
      }
      return data.alt_text;
    }
    const meta = data.meta;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
      throw new WordPressAdapterError(
        "CAPABILITY_UNAVAILABLE",
        "No editable SEO meta fields are exposed by this WordPress resource.",
      );
    }
    const value = (meta as Record<string, unknown>)[target.metaKey];
    if (typeof value !== "string") {
      throw new WordPressAdapterError(
        "CAPABILITY_UNAVAILABLE",
        "The configured SEO meta field is not readable as text.",
      );
    }
    return value;
  }

  async #assertMetaWritable(endpoint: string, metaKey: string): Promise<void> {
    const response = await this.#request(endpoint, "OPTIONS");
    const schema = await this.#json(response);
    const properties = readMetaProperties(schema);
    const field = properties?.[metaKey];
    if (!field || typeof field !== "object" || Array.isArray(field)) {
      throw new WordPressAdapterError(
        "CAPABILITY_UNAVAILABLE",
        "WordPress does not expose the configured SEO meta field.",
      );
    }
    const descriptor = field as Record<string, unknown>;
    const contexts = descriptor.context;
    if (
      descriptor.type !== "string" ||
      !Array.isArray(contexts) ||
      !contexts.includes("edit") ||
      descriptor.readonly === true
    ) {
      throw new WordPressAdapterError(
        "CAPABILITY_UNAVAILABLE",
        "The configured SEO meta field is not writable text.",
      );
    }
  }

  async #writeValue(target: WordPressPatchTarget, value: string): Promise<void> {
    const endpoint = this.#endpoint(target);
    const body =
      target.kind === "media" ? { alt_text: value } : { meta: { [target.metaKey]: value } };
    await this.#request(endpoint, "POST", body);
  }
}

function readMetaProperties(schema: Record<string, unknown>): Record<string, unknown> | null {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;
  const meta = (properties as Record<string, unknown>).meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const metaProperties = (meta as Record<string, unknown>).properties;
  if (!metaProperties || typeof metaProperties !== "object" || Array.isArray(metaProperties))
    return null;
  return metaProperties as Record<string, unknown>;
}

function validateTarget(target: WordPressPatchTarget): void {
  if (!Number.isSafeInteger(target.id) || target.id <= 0) {
    throw new WordPressAdapterError(
      "INVALID_TARGET",
      "WordPress resource id must be a positive integer.",
    );
  }
  if (target.kind === "post_meta" && (!target.metaKey.trim() || target.metaKey.length > 200)) {
    throw new WordPressAdapterError("INVALID_TARGET", "WordPress meta key is invalid.");
  }
}

function hashValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
