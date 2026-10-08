const INTERNAL_TEMPLATE_METADATA_KEYS = new Set([
  "templateId",
  "templateRoutePattern",
  "templateDomSignatureHash",
  "templateGroupingMethod",
]);

/** Keep crawl grouping identifiers in crawl history, not general evidence responses. */
export function publicEvidenceMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([key]) => !INTERNAL_TEMPLATE_METADATA_KEYS.has(key),
    ),
  );
}
