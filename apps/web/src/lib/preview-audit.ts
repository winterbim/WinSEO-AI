import { auditDomain, type DomainAuditResult } from "@serpvera/api/audit";
import {
  guardUrl,
  normalizeAuditTarget,
  SsrfError,
  UrlNormalizationError,
} from "@serpvera/crawler/audit-core";

export function prepareInlinePreviewTarget(submittedTarget: string): string {
  const targetUrl = normalizeAuditTarget(submittedTarget).normalized;
  guardUrl(targetUrl);
  return targetUrl;
}

export async function executeInlinePreviewAudit(
  submittedTarget: string,
  traceId: string,
  runAudit: typeof auditDomain = auditDomain,
): Promise<{ targetUrl: string; audit: DomainAuditResult }> {
  const targetUrl = prepareInlinePreviewTarget(submittedTarget);
  const audit = await runAudit(targetUrl, traceId, { render: false });
  return { targetUrl, audit };
}

export function isRejectedPreviewTarget(error: unknown): boolean {
  return error instanceof SsrfError || error instanceof UrlNormalizationError;
}
