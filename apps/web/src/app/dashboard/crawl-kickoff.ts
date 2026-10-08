export interface StartedCrawl {
  id: string;
  projectId: string;
  status: string;
}

export type CrawlKickoffResult =
  { ok: true; crawlRun: StartedCrawl } | { ok: false; message: string };

export function crawlTrackingHref(projectId: string, crawlRunId: string): string {
  return `/dashboard/${encodeURIComponent(projectId)}?crawlRunId=${encodeURIComponent(crawlRunId)}`;
}

export function reconcileTrackedCrawl<T extends { id: string }>(
  runs: readonly T[] | undefined,
  crawlRunId: string,
  consecutiveMisses: number,
):
  | { kind: "found"; run: T }
  | { kind: "retry"; consecutiveMisses: number }
  | { kind: "missing"; consecutiveMisses: number } {
  const run = runs?.find((candidate) => candidate.id === crawlRunId);
  if (run) return { kind: "found", run };
  const misses = consecutiveMisses + 1;
  return misses >= 3
    ? { kind: "missing", consecutiveMisses: misses }
    : { kind: "retry", consecutiveMisses: misses };
}

interface CrawlKickoffResponse {
  crawlRun?: Partial<StartedCrawl>;
  error?: { message?: string };
}

export async function startProjectCrawl(
  projectId: string,
  fetcher: typeof fetch = fetch,
): Promise<CrawlKickoffResult> {
  try {
    const response = await fetcher(`/api/v1/projects/${projectId}/crawl-runs`, {
      method: "POST",
    });
    const body = (await response.json().catch(() => ({}))) as CrawlKickoffResponse;
    if (response.ok) {
      const run = body.crawlRun;
      if (
        run &&
        typeof run.id === "string" &&
        typeof run.projectId === "string" &&
        typeof run.status === "string"
      ) {
        return { ok: true, crawlRun: run as StartedCrawl };
      }
      return { ok: false, message: "The service accepted no verifiable crawl run." };
    }

    return {
      ok: false,
      message: body.error?.message ?? "Could not start the crawl.",
    };
  } catch {
    return {
      ok: false,
      message:
        "Could not confirm whether the crawl started. Check the site before retrying; the request may have reached the service.",
    };
  }
}
