export interface GscSyncWindow {
  startDate: string;
  endDate: string;
}

export interface GscMetricRow {
  date: string;
  query: string;
  page: string;
  country: string;
  device: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscAdapter {
  readonly kind: "google" | "fixture";
  fetchSearchAnalytics(property: string, window: GscSyncWindow): Promise<readonly GscMetricRow[]>;
}

export interface GscMetricSink {
  persist(rows: readonly GscMetricRow[]): Promise<void>;
}

export interface GscSyncResult {
  property: string;
  window: GscSyncWindow;
  rowCount: number;
  adapterKind: GscAdapter["kind"];
}

export class GscCredentialsRequiredError extends Error {
  constructor() {
    super("Google Search Console credentials are required for the live adapter.");
    this.name = "GscCredentialsRequiredError";
  }
}
