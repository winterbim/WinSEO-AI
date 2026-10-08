import { isPrivacySafeTemplateGroupMetadata } from "@serpvera/crawler";
import type { StoredTemplateGroup } from "./types.ts";

/** Validate persisted crawl summaries before exposing them from any store adapter. */
export function parseStoredTemplateGroups(value: unknown): StoredTemplateGroup[] | null {
  if (!Array.isArray(value) || value.length > 200) return null;
  const groups: StoredTemplateGroup[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const group = item as Record<string, unknown>;
    if (
      typeof group.id !== "string" ||
      !/^[0-9a-f]{16}$/.test(group.id) ||
      typeof group.routePattern !== "string" ||
      !group.routePattern.startsWith("/") ||
      group.routePattern.length > 2_048 ||
      !(group.domSignatureHash === null || typeof group.domSignatureHash === "string") ||
      (typeof group.domSignatureHash === "string" &&
        !/^[0-9a-f]{64}$/.test(group.domSignatureHash)) ||
      !Number.isInteger(group.pageCount) ||
      (group.pageCount as number) < 1 ||
      (group.pageCount as number) > 200 ||
      !Array.isArray(group.sampleUrls) ||
      group.sampleUrls.length === 0 ||
      group.sampleUrls.length > 3 ||
      (group.groupingMethod === "URL_PATTERN_AND_SEMANTIC_DOM_V2" &&
        group.routePattern.split("/").includes(":private")) ||
      (group.groupingMethod !== "URL_PATTERN_AND_SEMANTIC_DOM_V2" &&
        group.groupingMethod !== "URL_PATTERN_ONLY_PRIVACY_SINGLETON_V2" &&
        group.groupingMethod !== "SEMANTIC_DOM_PRIVACY_SINGLETON_V1") ||
      (group.groupingMethod === "URL_PATTERN_AND_SEMANTIC_DOM_V2" &&
        typeof group.domSignatureHash !== "string") ||
      (group.groupingMethod === "URL_PATTERN_ONLY_PRIVACY_SINGLETON_V2" &&
        (group.domSignatureHash !== null || group.pageCount !== 1)) ||
      (group.groupingMethod === "SEMANTIC_DOM_PRIVACY_SINGLETON_V1" &&
        (typeof group.domSignatureHash !== "string" ||
          group.pageCount !== 1 ||
          !group.routePattern.split("/").some(isRedactedRouteValue)))
    ) {
      return null;
    }
    const sampleUrls: string[] = [];
    for (const sampleUrl of group.sampleUrls as unknown[]) {
      if (typeof sampleUrl !== "string" || sampleUrl.length > 2_048 || /[?#]/.test(sampleUrl))
        return null;
      sampleUrls.push(sampleUrl);
    }
    if (group.pageCount === 1 && sampleUrls.length !== 1) {
      return null;
    }
    if (
      !isPrivacySafeTemplateGroupMetadata(
        group.routePattern,
        sampleUrls,
        group.groupingMethod,
        group.pageCount as number,
      )
    ) {
      return null;
    }
    groups.push({
      id: group.id,
      routePattern: group.routePattern,
      domSignatureHash: group.domSignatureHash,
      pageCount: group.pageCount as number,
      sampleUrls,
      groupingMethod: group.groupingMethod,
    });
  }
  return groups;
}

function isRedactedRouteValue(segment: string): boolean {
  return (
    segment === ":private" ||
    segment === ":id" ||
    segment === ":date" ||
    /^(article|item|page|post|product|recipe|story|video)-:id$/.test(segment)
  );
}
