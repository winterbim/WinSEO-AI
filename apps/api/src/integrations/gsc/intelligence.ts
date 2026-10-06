// ─── GSC Intelligence ───
// Deterministic analytics over persisted first-party Search Analytics rows.
//
// Rules that make these modules trustworthy:
//   • Pure functions. Same rows in → same recommendations out. No model, no
//     randomness, no clock (windows are always passed in).
//   • Every output is a MEASUREMENT, never an opinion: it carries the exact
//     dataset window, the filters that selected the rows, the comparison
//     window when one exists, and the observed values it was derived from.
//   • Every recommendation declares the gate that can later confirm or refute
//     it, computed from the same numbers — so VERIFIED/REJECTED is arithmetic,
//     not judgement.
//
// Nothing here invents data: an empty input yields an empty output.

export interface MetricRow {
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

export interface MetricWindow {
  startDate: string;
  endDate: string;
}

export type IntelligenceModule =
  | "high_impressions_low_ctr"
  | "ranking_opportunity"
  | "page_query_decay"
  | "query_cannibalization"
  | "emerging_queries"
  | "winners_losers"
  | "page_query_intersections"
  | "pre_post_comparison";

export type MetricName = "ctr" | "clicks" | "impressions" | "position";

export interface VerificationGateSpec {
  type: "gsc_window";
  spec: {
    metric: MetricName;
    operator: "gte" | "lte";
    threshold: number;
    query?: string;
    page?: string;
    device?: string;
    country?: string;
    minImpressions: number;
    windowDays: number;
  };
}

export interface RecommendationSubject {
  query?: string;
  page?: string;
  device?: string;
  country?: string;
}

/** A measured, reproducible recommendation. `evidenceClass` is MEASURED by type. */
export interface MeasuredRecommendation {
  module: IntelligenceModule;
  subject: RecommendationSubject;
  title: string;
  rationale: string;
  datasetWindow: MetricWindow;
  /** Every criterion used to select/derive the rows, in one reproducible object. */
  filters: Record<string, string | number | boolean>;
  comparisonWindow?: MetricWindow;
  observed: Record<string, number | string>;
  baseline?: Record<string, number | string>;
  delta?: Record<string, number>;
  evidenceClass: "MEASURED";
  verificationGate: VerificationGateSpec;
  severity: "critical" | "high" | "medium" | "low" | "info";
}

export interface Thresholds {
  /** Minimum impressions before any claim is made from a row. */
  minImpressions: number;
}

// ─── Aggregation (impression-weighted, never an average of averages) ───

export interface AggregatedSubject {
  key: string;
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  days: number;
}

function aggregate(
  rows: readonly MetricRow[],
  group: (row: MetricRow) => { query: string; page: string },
): AggregatedSubject[] {
  const map = new Map<
    string,
    {
      query: string;
      page: string;
      clicks: number;
      impressions: number;
      weighted: number;
      days: Set<string>;
    }
  >();
  for (const row of rows) {
    const { query, page } = group(row);
    const key = `${query} ${page}`;
    const entry = map.get(key);
    if (!entry) {
      map.set(key, {
        query,
        page,
        clicks: row.clicks,
        impressions: row.impressions,
        weighted: row.position * row.impressions,
        days: new Set([row.date]),
      });
      continue;
    }
    entry.clicks += row.clicks;
    entry.impressions += row.impressions;
    entry.weighted += row.position * row.impressions;
    entry.days.add(row.date);
  }
  return [...map.values()]
    .map((e) => ({
      // Rebuilt from the group, matching the map's own key format exactly.
      key: `${e.query} ${e.page}`,
      query: e.query,
      page: e.page,
      clicks: e.clicks,
      impressions: e.impressions,
      ctr: e.impressions > 0 ? e.clicks / e.impressions : 0,
      position: e.impressions > 0 ? e.weighted / e.impressions : 0,
      days: e.days.size,
    }))
    .sort((a, b) => b.impressions - a.impressions || a.key.localeCompare(b.key));
}

const round = (value: number, digits = 6): number => Number(value.toFixed(digits));
const pct = (from: number, to: number): number =>
  from === 0 ? 0 : round((to - from) / from, 6);

function severityForImpressions(impressions: number): MeasuredRecommendation["severity"] {
  if (impressions >= 10_000) return "critical";
  if (impressions >= 1_000) return "high";
  if (impressions >= 300) return "medium";
  return "low";
}

function buildGate(
  spec: Omit<VerificationGateSpec["spec"], "minImpressions"> & { minImpressions?: number },
  subject: RecommendationSubject,
  minImpressions: number,
): VerificationGateSpec {
  return {
    type: "gsc_window",
    spec: {
      metric: spec.metric,
      operator: spec.operator,
      threshold: spec.threshold,
      ...(subject.query ? { query: subject.query } : {}),
      ...(subject.page ? { page: subject.page } : {}),
      minImpressions: spec.minImpressions ?? minImpressions,
      windowDays: spec.windowDays,
    },
  };
}

// ─── 1. High impressions, low CTR ───

export interface HighImpressionLowCtrOptions extends Thresholds {
  maxCtr: number;
  windowDays: number;
}

export const DEFAULT_HIGH_IMPRESSION_LOW_CTR: HighImpressionLowCtrOptions = {
  minImpressions: 500,
  maxCtr: 0.02,
  windowDays: 30,
};

export function highImpressionsLowCtr(
  rows: readonly MetricRow[],
  window: MetricWindow,
  options: Partial<HighImpressionLowCtrOptions> = {},
): MeasuredRecommendation[] {
  const opts = { ...DEFAULT_HIGH_IMPRESSION_LOW_CTR, ...options };
  return aggregate(rows, (r) => ({ query: r.query, page: r.page }))
    .filter((s) => s.impressions >= opts.minImpressions && s.ctr < opts.maxCtr)
    .map((s) => {
      const subject: RecommendationSubject = { query: s.query, page: s.page };
      return {
        module: "high_impressions_low_ctr" as const,
        subject,
        title: `Low CTR for "${s.query}" on ${s.page} (${round(s.ctr * 100, 3)}%)`,
        rationale:
          `${s.impressions} impressions produced ${s.clicks} clicks at position ` +
          `${round(s.position, 2)} — visibility exists but the result is not being chosen.`,
        datasetWindow: window,
        filters: { minImpressions: opts.minImpressions, maxCtr: opts.maxCtr },
        observed: {
          impressions: s.impressions,
          clicks: s.clicks,
          ctr: round(s.ctr),
          position: round(s.position, 3),
          days: s.days,
        },
        evidenceClass: "MEASURED" as const,
        verificationGate: buildGate(
          {
            metric: "ctr",
            operator: "gte",
            threshold: opts.maxCtr,
            minImpressions: opts.minImpressions,
            windowDays: opts.windowDays,
          },
          subject,
          opts.minImpressions,
        ),
        severity: severityForImpressions(s.impressions),
      };
    });
}

// ─── 2. Ranking opportunity window (position 6–15) ───

export interface RankingOpportunityOptions extends Thresholds {
  minPosition: number;
  maxPosition: number;
  /** Where the recommendation wants the query to land. */
  targetPosition: number;
  windowDays: number;
}

export const DEFAULT_RANKING_OPPORTUNITY: RankingOpportunityOptions = {
  minImpressions: 200,
  minPosition: 6,
  maxPosition: 15,
  targetPosition: 5,
  windowDays: 30,
};

export function rankingOpportunityWindows(
  rows: readonly MetricRow[],
  window: MetricWindow,
  options: Partial<RankingOpportunityOptions> = {},
): MeasuredRecommendation[] {
  const opts = { ...DEFAULT_RANKING_OPPORTUNITY, ...options };
  return aggregate(rows, (r) => ({ query: r.query, page: r.page }))
    .filter(
      (s) =>
        s.impressions >= opts.minImpressions &&
        s.position >= opts.minPosition &&
        s.position <= opts.maxPosition,
    )
    .map((s) => {
      const subject: RecommendationSubject = { query: s.query, page: s.page };
      return {
        module: "ranking_opportunity" as const,
        subject,
        title: `"${s.query}" ranks ${round(s.position, 2)} — inside the opportunity window`,
        rationale:
          `Position ${round(s.position, 2)} sits between ${opts.minPosition} and ` +
          `${opts.maxPosition}: small gains convert into impressions already being served.`,
        datasetWindow: window,
        filters: {
          minImpressions: opts.minImpressions,
          minPosition: opts.minPosition,
          maxPosition: opts.maxPosition,
          targetPosition: opts.targetPosition,
        },
        observed: {
          impressions: s.impressions,
          clicks: s.clicks,
          ctr: round(s.ctr),
          position: round(s.position, 3),
          days: s.days,
        },
        evidenceClass: "MEASURED" as const,
        verificationGate: buildGate(
          {
            metric: "position",
            operator: "lte",
            threshold: opts.targetPosition,
            minImpressions: opts.minImpressions,
            windowDays: opts.windowDays,
          },
          subject,
          opts.minImpressions,
        ),
        severity: severityForImpressions(s.impressions),
      };
    });
}

// ─── 3. Page/query decay ───

export interface DecayOptions extends Thresholds {
  /** Relative drop required to call it decay (0.25 = −25%). */
  decayThreshold: number;
  windowDays: number;
}

export const DEFAULT_DECAY: DecayOptions = {
  minImpressions: 100,
  decayThreshold: 0.25,
  windowDays: 30,
};

export function pageQueryDecay(
  current: readonly MetricRow[],
  baseline: readonly MetricRow[],
  currentWindow: MetricWindow,
  baselineWindow: MetricWindow,
  options: Partial<DecayOptions> = {},
): MeasuredRecommendation[] {
  const opts = { ...DEFAULT_DECAY, ...options };
  const now = aggregate(current, (r) => ({ query: r.query, page: r.page }));
  const before = new Map(
    aggregate(baseline, (r) => ({ query: r.query, page: r.page })).map((s) => [s.key, s]),
  );
  const out: MeasuredRecommendation[] = [];
  for (const s of now) {
    const prior = before.get(s.key);
    if (!prior || prior.impressions < opts.minImpressions) continue;
    const change = pct(prior.impressions, s.impressions);
    if (change > -opts.decayThreshold) continue;
    const subject: RecommendationSubject = { query: s.query, page: s.page };
    out.push({
      module: "page_query_decay",
      subject,
      title: `Impressions for "${s.query}" on ${s.page} fell ${round(change * 100, 2)}%`,
      rationale:
        `Baseline ${prior.impressions} impressions → ${s.impressions} in the current window ` +
        `(decay threshold ${opts.decayThreshold * 100}%).`,
      datasetWindow: currentWindow,
      filters: { minImpressions: opts.minImpressions, decayThreshold: opts.decayThreshold },
      comparisonWindow: baselineWindow,
      observed: {
        impressions: s.impressions,
        clicks: s.clicks,
        ctr: round(s.ctr),
        position: round(s.position, 3),
      },
      baseline: {
        impressions: prior.impressions,
        clicks: prior.clicks,
        ctr: round(prior.ctr),
        position: round(prior.position, 3),
      },
      delta: { impressions: change, clicks: pct(prior.clicks, s.clicks) },
      evidenceClass: "MEASURED",
      verificationGate: buildGate(
        {
          metric: "impressions",
          operator: "gte",
          threshold: prior.impressions,
          minImpressions: opts.minImpressions,
          windowDays: opts.windowDays,
        },
        subject,
        opts.minImpressions,
      ),
      severity: severityForImpressions(prior.impressions),
    });
  }
  return out;
}

// ─── 4. Query cannibalization ───

export interface CannibalizationOptions extends Thresholds {
  minImpressionsPerPage: number;
  windowDays: number;
  /** Query-level clicks must improve by this relative amount to verify. */
  targetClicksLift: number;
}

export const DEFAULT_CANNIBALIZATION: CannibalizationOptions = {
  minImpressions: 100,
  minImpressionsPerPage: 50,
  windowDays: 30,
  targetClicksLift: 0.1,
};

export function queryCannibalization(
  rows: readonly MetricRow[],
  window: MetricWindow,
  options: Partial<CannibalizationOptions> = {},
): MeasuredRecommendation[] {
  const opts = { ...DEFAULT_CANNIBALIZATION, ...options };
  const byQuery = new Map<string, AggregatedSubject[]>();
  for (const s of aggregate(rows, (r) => ({ query: r.query, page: r.page }))) {
    const list = byQuery.get(s.query) ?? [];
    list.push(s);
    byQuery.set(s.query, list);
  }

  const out: MeasuredRecommendation[] = [];
  for (const [query, pages] of [...byQuery.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const qualifying = pages.filter((p) => p.impressions >= opts.minImpressionsPerPage);
    if (qualifying.length < 2) continue;
    const totalImpressions = qualifying.reduce((sum, p) => sum + p.impressions, 0);
    if (totalImpressions < opts.minImpressions) continue;
    const totalClicks = qualifying.reduce((sum, p) => sum + p.clicks, 0);
    const target = Math.ceil(totalClicks * (1 + opts.targetClicksLift));
    const subject: RecommendationSubject = { query };
    out.push({
      module: "query_cannibalization",
      subject,
      title: `"${query}" competes across ${qualifying.length} pages`,
      rationale:
        `Pages exceeding ${opts.minImpressionsPerPage} impressions each compete for one query; ` +
        `clicks split ${qualifying.map((p) => `${p.clicks} (${p.page})`).join(", ")}.`,
      datasetWindow: window,
      filters: {
        minImpressionsPerPage: opts.minImpressionsPerPage,
        targetClicksLift: opts.targetClicksLift,
      },
      observed: {
        competingPages: qualifying.length,
        totalImpressions,
        totalClicks,
        ctr: totalImpressions > 0 ? round(totalClicks / totalImpressions) : 0,
        pages: qualifying
          .map((p) => `${p.page} (${p.impressions} impr, pos ${round(p.position, 2)})`)
          .join(" | "),
      },
      evidenceClass: "MEASURED",
      verificationGate: buildGate(
        {
          metric: "clicks",
          operator: "gte",
          threshold: target,
          minImpressions: opts.minImpressions,
          windowDays: opts.windowDays,
        },
        subject,
        opts.minImpressions,
      ),
      severity: severityForImpressions(totalImpressions),
    });
  }
  return out;
}

// ─── 5. Emerging queries ───

export interface EmergingOptions extends Thresholds {
  /** Growth target applied to the first observed impression count. */
  growthFactor: number;
  baselineMaxImpressions: number;
  windowDays: number;
}

export const DEFAULT_EMERGING: EmergingOptions = {
  minImpressions: 100,
  growthFactor: 1.5,
  baselineMaxImpressions: 10,
  windowDays: 30,
};

export function emergingQueries(
  current: readonly MetricRow[],
  baseline: readonly MetricRow[],
  currentWindow: MetricWindow,
  baselineWindow: MetricWindow,
  options: Partial<EmergingOptions> = {},
): MeasuredRecommendation[] {
  const opts = { ...DEFAULT_EMERGING, ...options };
  const now = aggregate(current, (r) => ({ query: r.query, page: r.page }));
  const before = new Map(
    aggregate(baseline, (r) => ({ query: r.query, page: r.page })).map((s) => [s.key, s]),
  );
  const out: MeasuredRecommendation[] = [];
  for (const s of now) {
    if (s.impressions < opts.minImpressions) continue;
    const prior = before.get(s.key);
    const priorImpressions = prior?.impressions ?? 0;
    if (priorImpressions > opts.baselineMaxImpressions) continue; // already established
    const subject: RecommendationSubject = { query: s.query, page: s.page };
    const target = Math.ceil(s.impressions * opts.growthFactor);
    out.push({
      module: "emerging_queries",
      subject,
      title: `Emerging: "${s.query}" gained ${s.impressions} impressions`,
      rationale:
        `Baseline window held ${priorImpressions} impressions for this pair; the current ` +
        `window holds ${s.impressions}. Growth target = ${opts.growthFactor}× the first observation.`,
      datasetWindow: currentWindow,
      filters: {
        minImpressions: opts.minImpressions,
        growthFactor: opts.growthFactor,
        baselineMaxImpressions: opts.baselineMaxImpressions,
      },
      comparisonWindow: baselineWindow,
      observed: {
        impressions: s.impressions,
        clicks: s.clicks,
        ctr: round(s.ctr),
        position: round(s.position, 3),
        days: s.days,
      },
      baseline: { impressions: priorImpressions, present: prior ? 1 : 0 },
      delta: { impressions: pct(priorImpressions, s.impressions) },
      evidenceClass: "MEASURED",
      verificationGate: buildGate(
        {
          metric: "impressions",
          operator: "gte",
          threshold: target,
          minImpressions: opts.minImpressions,
          windowDays: opts.windowDays,
        },
        subject,
        opts.minImpressions,
      ),
      severity: severityForImpressions(s.impressions),
    });
  }
  return out;
}

// ─── 6. Winners / losers ───

export interface WinnersLosersOptions extends Thresholds {
  minRelativeChange: number;
  windowDays: number;
}

export const DEFAULT_WINNERS_LOSERS: WinnersLosersOptions = {
  minImpressions: 50,
  minRelativeChange: 0.2,
  windowDays: 30,
};

export function winnersLosers(
  current: readonly MetricRow[],
  baseline: readonly MetricRow[],
  currentWindow: MetricWindow,
  baselineWindow: MetricWindow,
  options: Partial<WinnersLosersOptions> = {},
): MeasuredRecommendation[] {
  const opts = { ...DEFAULT_WINNERS_LOSERS, ...options };
  const now = new Map(
    aggregate(current, (r) => ({ query: r.query, page: r.page })).map((s) => [s.key, s]),
  );
  const before = new Map(
    aggregate(baseline, (r) => ({ query: r.query, page: r.page })).map((s) => [s.key, s]),
  );

  const out: MeasuredRecommendation[] = [];
  for (const [key, prior] of before) {
    if (prior.impressions < opts.minImpressions) continue;
    const s = now.get(key);
    const currentClicks = s?.clicks ?? 0;
    const change = pct(prior.clicks, currentClicks);
    if (Math.abs(change) < opts.minRelativeChange) continue;
    const isWinner = change > 0;
    const subject: RecommendationSubject = { query: prior.query, page: prior.page };
    out.push({
      module: "winners_losers",
      subject,
      title:
        `${isWinner ? "Winner" : "Loser"}: "${prior.query}" on ${prior.page} ` +
        `${change > 0 ? "+" : ""}${round(change * 100, 2)}% clicks`,
      rationale: isWinner
        ? `Clicks rose from ${prior.clicks} to ${currentClicks} between the comparison and current windows.`
        : `Clicks fell from ${prior.clicks} to ${currentClicks} between the comparison and current windows.`,
      datasetWindow: currentWindow,
      filters: {
        minImpressions: opts.minImpressions,
        minRelativeChange: opts.minRelativeChange,
      },
      comparisonWindow: baselineWindow,
      observed: {
        clicks: currentClicks,
        impressions: s?.impressions ?? 0,
        ctr: round(s?.ctr ?? 0),
        position: round(s?.position ?? 0, 3),
      },
      baseline: {
        clicks: prior.clicks,
        impressions: prior.impressions,
        ctr: round(prior.ctr),
        position: round(prior.position, 3),
      },
      delta: { clicks: change, impressions: pct(prior.impressions, s?.impressions ?? 0) },
      evidenceClass: "MEASURED",
      verificationGate: buildGate(
        {
          metric: "clicks",
          operator: "gte",
          threshold: isWinner ? currentClicks : prior.clicks,
          minImpressions: opts.minImpressions,
          windowDays: opts.windowDays,
        },
        subject,
        opts.minImpressions,
      ),
      severity: isWinner ? "low" : severityForImpressions(prior.impressions),
    });
  }
  return out.sort(
    (a, b) =>
      a.module.localeCompare(b.module) ||
      JSON.stringify(a.subject).localeCompare(JSON.stringify(b.subject)),
  );
}

// ─── 7. Page / query intersections ───

export interface IntersectionOptions extends Thresholds {
  topQueriesPerPage: number;
  windowDays: number;
  /** Relative clicks gain the page must reach to verify. */
  targetClicksLift: number;
}

export const DEFAULT_INTERSECTIONS: IntersectionOptions = {
  minImpressions: 100,
  topQueriesPerPage: 5,
  windowDays: 30,
  targetClicksLift: 0.15,
};

export function pageQueryIntersections(
  rows: readonly MetricRow[],
  window: MetricWindow,
  options: Partial<IntersectionOptions> = {},
): MeasuredRecommendation[] {
  const opts = { ...DEFAULT_INTERSECTIONS, ...options };
  const byPage = new Map<string, AggregatedSubject[]>();
  for (const s of aggregate(rows, (r) => ({ query: r.query, page: r.page }))) {
    const list = byPage.get(s.page) ?? [];
    list.push(s);
    byPage.set(s.page, list);
  }

  const out: MeasuredRecommendation[] = [];
  for (const [page, queries] of [...byPage.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const relevant = queries.filter((q) => q.impressions >= opts.minImpressions);
    if (relevant.length === 0) continue;
    const top = relevant.slice(0, opts.topQueriesPerPage);
    const impressions = relevant.reduce((sum, q) => sum + q.impressions, 0);
    const clicks = relevant.reduce((sum, q) => sum + q.clicks, 0);
    const weightedPosition =
      impressions > 0
        ? relevant.reduce((sum, q) => sum + q.position * q.impressions, 0) / impressions
        : 0;
    const subject: RecommendationSubject = { page };
    out.push({
      module: "page_query_intersections",
      subject,
      title: `${page} ranks for ${relevant.length} measured queries`,
      rationale:
        `Top ${top.length} of ${relevant.length} queries by impressions: ` +
        `${top.map((q) => `"${q.query}" (${q.impressions})`).join(", ")}.`,
      datasetWindow: window,
      filters: {
        minImpressions: opts.minImpressions,
        topQueriesPerPage: opts.topQueriesPerPage,
        targetClicksLift: opts.targetClicksLift,
      },
      observed: {
        queryCount: relevant.length,
        impressions,
        clicks,
        ctr: impressions > 0 ? round(clicks / impressions) : 0,
        position: round(weightedPosition, 3),
        topQueries: top.map((q) => q.query).join(" | "),
      },
      evidenceClass: "MEASURED",
      verificationGate: buildGate(
        {
          metric: "clicks",
          operator: "gte",
          threshold: Math.ceil(clicks * (1 + opts.targetClicksLift)),
          minImpressions: opts.minImpressions,
          windowDays: opts.windowDays,
        },
        subject,
        opts.minImpressions,
      ),
      severity: severityForImpressions(impressions),
    });
  }
  return out;
}

// ─── 8. Pre/post intervention comparison ───

export interface PrePostOptions extends Thresholds {
  /** Relative change that counts as a real movement. */
  materialChange: number;
  windowDays: number;
}

export const DEFAULT_PRE_POST: PrePostOptions = {
  minImpressions: 50,
  materialChange: 0.1,
  windowDays: 30,
};

/**
 * Compare one subject across two windows.
 *
 * This is the module the Action Center's before/after panel renders: the same
 * arithmetic the verification gate will later re-run on fresh data.
 */
export function prePostComparison(
  before: readonly MetricRow[],
  after: readonly MetricRow[],
  baselineWindow: MetricWindow,
  afterWindow: MetricWindow,
  subject: RecommendationSubject,
  options: Partial<PrePostOptions> = {},
): MeasuredRecommendation | null {
  const opts = { ...DEFAULT_PRE_POST, ...options };
  const matches = (row: MetricRow): boolean =>
    (subject.query === undefined || row.query === subject.query) &&
    (subject.page === undefined || row.page === subject.page) &&
    (subject.device === undefined || row.device === subject.device) &&
    (subject.country === undefined || row.country === subject.country);

  const summarize = (rows: readonly MetricRow[]) => {
    const selected = rows.filter(matches);
    const impressions = selected.reduce((sum, r) => sum + r.impressions, 0);
    const clicks = selected.reduce((sum, r) => sum + r.clicks, 0);
    const weighted = selected.reduce((sum, r) => sum + r.position * r.impressions, 0);
    return {
      impressions,
      clicks,
      ctr: impressions > 0 ? clicks / impressions : 0,
      position: impressions > 0 ? weighted / impressions : 0,
      rows: selected.length,
    };
  };

  const prior = summarize(before);
  const current = summarize(after);
  if (prior.impressions < opts.minImpressions && current.impressions < opts.minImpressions) {
    return null; // not enough measured data to state anything
  }

  const clickDelta = pct(prior.clicks, current.clicks);
  const impressionDelta = pct(prior.impressions, current.impressions);
  const positionDelta = round(current.position - prior.position, 6);
  const moved =
    Math.abs(clickDelta) >= opts.materialChange ||
    Math.abs(impressionDelta) >= opts.materialChange;

  const target =
    prior.clicks > 0
      ? Math.max(1, Math.ceil(prior.clicks * (1 + opts.materialChange)))
      : current.clicks;

  return {
    module: "pre_post_comparison",
    subject,
    title:
      `Before/after for ${subject.query ?? "*"} on ${subject.page ?? "*"}: ` +
      `${clickDelta > 0 ? "+" : ""}${round(clickDelta * 100, 2)}% clicks`,
    rationale:
      `Baseline window ${baselineWindow.startDate}..${baselineWindow.endDate} vs ` +
      `measurement window ${afterWindow.startDate}..${afterWindow.endDate}. ` +
      `Position moved ${positionDelta >= 0 ? "+" : ""}${positionDelta}.`,
    datasetWindow: afterWindow,
    filters: {
      ...(subject.query ? { query: subject.query } : {}),
      ...(subject.page ? { page: subject.page } : {}),
      ...(subject.device ? { device: subject.device } : {}),
      ...(subject.country ? { country: subject.country } : {}),
      minImpressions: opts.minImpressions,
      materialChange: opts.materialChange,
    },
    comparisonWindow: baselineWindow,
    observed: {
      clicks: current.clicks,
      impressions: current.impressions,
      ctr: round(current.ctr),
      position: round(current.position, 3),
      rows: current.rows,
    },
    baseline: {
      clicks: prior.clicks,
      impressions: prior.impressions,
      ctr: round(prior.ctr),
      position: round(prior.position, 3),
      rows: prior.rows,
    },
    delta: { clicks: clickDelta, impressions: impressionDelta, position: positionDelta },
    evidenceClass: "MEASURED",
    verificationGate: buildGate(
      {
        metric: "clicks",
        operator: "gte",
        threshold: target,
        minImpressions: opts.minImpressions,
        windowDays: opts.windowDays,
      },
      subject,
      opts.minImpressions,
    ),
    severity: moved ? "medium" : "low",
  };
}

/** Stable identifier for a recommendation (used to avoid duplicate findings). */
export function recommendationRuleId(rec: MeasuredRecommendation): string {
  const scope = [rec.subject.query, rec.subject.page].filter(Boolean).join("::");
  return `GSC.${rec.module}${scope ? `::${scope}` : ""}`;
}

export interface DimensionSummary {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  days: number;
}

/**
 * Group rows by one dimension for the queries/pages tables.
 *
 * Impression-weighted position and a derived CTR — the same arithmetic every
 * other module uses, so a table cell and a gate always agree.
 */
export function summarizeByDimension(
  rows: readonly MetricRow[],
  dimension: "query" | "page",
): DimensionSummary[] {
  const map = new Map<
    string,
    { clicks: number; impressions: number; weighted: number; days: Set<string> }
  >();
  for (const row of rows) {
    const key = dimension === "query" ? row.query : row.page;
    const entry = map.get(key);
    if (!entry) {
      map.set(key, {
        clicks: row.clicks,
        impressions: row.impressions,
        weighted: row.position * row.impressions,
        days: new Set([row.date]),
      });
      continue;
    }
    entry.clicks += row.clicks;
    entry.impressions += row.impressions;
    entry.weighted += row.position * row.impressions;
    entry.days.add(row.date);
  }
  return [...map.entries()]
    .map(([key, e]) => ({
      key,
      clicks: e.clicks,
      impressions: e.impressions,
      ctr: e.impressions > 0 ? e.clicks / e.impressions : 0,
      position: e.impressions > 0 ? e.weighted / e.impressions : 0,
      days: e.days.size,
    }))
    .sort((a, b) => b.impressions - a.impressions || a.key.localeCompare(b.key));
}
