export function crawlCoverageLabel(
  status: string,
  stopReason: string | null,
  pageLimit: number | null,
): string {
  switch (stopReason) {
    case "page_limit":
      return pageLimit === null
        ? "Partial coverage · recorded page limit reached"
        : `Partial coverage · ${pageLimit}-page limit reached`;
    case "time_budget":
      return "Partial coverage · time budget reached";
    case "server_throttled":
      return "Partial coverage · site throttled the crawl";
    case "robots_unavailable":
      return "Stopped · robots.txt could not be read";
    case "robots_blocked":
      return "Stopped · submitted page is disallowed by robots.txt";
    default:
      if (status === "completed") {
        return pageLimit === null
          ? "Coverage details unavailable for this historical crawl"
          : `Discovery queue ended · max ${pageLimit} pages; site-wide coverage is not implied`;
      }
      return pageLimit === null
        ? "Coverage details pending for this crawl"
        : `Up to ${pageLimit} pages per run`;
  }
}
