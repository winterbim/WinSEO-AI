import type {
  GscAdapter,
  GscMetricRow,
  GscMetricSink,
  GscSyncResult,
  GscSyncWindow,
} from "./types.ts";
import { GscCredentialsRequiredError } from "./types.ts";

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

export function validateGscRow(row: GscMetricRow, window: GscSyncWindow): void {
  if (!validDate(row.date) || row.date < window.startDate || row.date > window.endDate) {
    throw new Error(`GSC row date ${row.date} is outside the requested window.`);
  }
  if (!row.page.startsWith("https://") && !row.page.startsWith("http://")) {
    throw new Error("GSC page dimension must be an absolute HTTP(S) URL.");
  }
  for (const [name, value] of Object.entries({
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
  })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid GSC ${name}.`);
  }
  if (row.ctr > 1) throw new Error("Invalid GSC ctr.");
}

export async function runGscSync(
  adapter: GscAdapter,
  sink: GscMetricSink,
  property: string,
  window: GscSyncWindow,
): Promise<GscSyncResult> {
  if (!property.trim()) throw new Error("GSC property is required.");
  if (
    !validDate(window.startDate) ||
    !validDate(window.endDate) ||
    window.endDate < window.startDate
  ) {
    throw new Error("GSC sync window is invalid.");
  }
  const rows = await adapter.fetchSearchAnalytics(property, window);
  rows.forEach((row) => { validateGscRow(row, window); });
  await sink.persist(rows);
  return { property, window, rowCount: rows.length, adapterKind: adapter.kind };
}

/** Production placeholder: architecture is runnable, but a missing credential
 * fails explicitly instead of silently returning fabricated empty metrics. */
export class GoogleGscAdapter implements GscAdapter {
  readonly kind = "google" as const;
  private readonly credentialRef?: string;
  constructor(credentialRef?: string) {
    this.credentialRef = credentialRef;
  }

  fetchSearchAnalytics(): Promise<readonly GscMetricRow[]> {
    // Synchronously throws: the credential gate must reject the sync contract
    // before any transport is attempted.
    if (!this.credentialRef) throw new GscCredentialsRequiredError();
    throw new Error("Live Google transport is not configured in this deployment.");
  }
}

export class FixtureGscAdapter implements GscAdapter {
  readonly kind = "fixture" as const;
  private readonly rows: readonly GscMetricRow[];
  constructor(rows: readonly GscMetricRow[]) {
    this.rows = rows;
  }

  fetchSearchAnalytics(): Promise<readonly GscMetricRow[]> {
    return Promise.resolve(this.rows);
  }
}
