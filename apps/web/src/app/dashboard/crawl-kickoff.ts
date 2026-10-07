export interface StartedCrawl {
  id: string;
  projectId: string;
  status: string;
}

export type CrawlKickoffResult =
  { ok: true; crawlRun: StartedCrawl } | { ok: false; message: string };

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
