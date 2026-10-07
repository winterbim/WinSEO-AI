export type CrawlKickoffResult = { ok: true } | { ok: false; message: string };

interface CrawlErrorResponse {
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
    if (response.ok) return { ok: true };

    const body = (await response.json().catch(() => ({}))) as CrawlErrorResponse;
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
