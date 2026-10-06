export const dynamic = "force-dynamic";
export const maxDuration = 45;

import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createPreviewRateLimiter } from "@/lib/preview-rate-limit";
import {
  executeInlinePreviewAudit,
  isRejectedPreviewTarget,
  prepareInlinePreviewTarget,
} from "@/lib/preview-audit";

// ─── BFF proxy to the control-plane API ───
// Blueprint §10.1 / §23: /apps/web is Next.js marketing+app (BFF); /apps/api is
// the control plane. The scan engine (SSRF guard, crawling, deterministic rules,
// persistence) lives ONCE in the control plane. This route does not re-implement
// it — duplicating it would create two sources of truth and two places where the
// SSRF guard could drift.
//
// Without a control plane, a real but explicitly limited inline audit is
// available only on development and Vercel preview deployments. Production
// still fails closed; this route never returns fabricated scan results.

const API_URL = process.env.API_URL ?? "http://localhost:3001";
const UPSTREAM_TIMEOUT_MS = 20_000;
const previewScanLimiter = createPreviewRateLimiter(5, 60 * 60 * 1000);

function apiBase(): string {
  return API_URL.replace(/\/+$/, "");
}

function upstreamUnavailable(detail: string) {
  return NextResponse.json(
    {
      error: {
        code: "AUDIT_SERVICE_UNAVAILABLE",
        message:
          "The audit service is temporarily unavailable. No scan was started and no results were generated.",
      },
      detail,
    },
    { status: 503 },
  );
}

/** Proxy a request to the control plane, preserving status and JSON body. */
async function proxy(method: "POST" | "GET", path: string, body?: unknown) {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      // SSRF note: API_URL is operator-configured infrastructure, never
      // user-supplied, so this hop is not part of the user-URL SSRF surface.
      cache: "no-store",
    });
  } catch (err) {
    return upstreamUnavailable(
      `control plane unreachable at ${apiBase()} (${(err as Error).message})`,
    );
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    return upstreamUnavailable("control plane returned a non-JSON response");
  }

  return NextResponse.json(parsed, { status: res.status });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_JSON", message: "Invalid JSON body." } },
      { status: 400 },
    );
  }

  // If configured, the control plane remains authoritative for validation,
  // persistence and its durable per-IP quota.
  const shape = body as { domain?: unknown };
  if (
    typeof shape.domain !== "string" ||
    shape.domain.trim() === "" ||
    shape.domain.length > 2048
  ) {
    return NextResponse.json(
      { error: { code: "INVALID_URL", message: "Enter a URL of at most 2,048 characters." } },
      { status: 400 },
    );
  }

  if (process.env.API_URL) {
    return proxy("POST", "/v1/public-scans", { domain: shape.domain.trim() });
  }

  const previewEnabled =
    process.env.NODE_ENV !== "production" || process.env.VERCEL_ENV === "preview";
  if (!previewEnabled)
    return upstreamUnavailable("No public audit service is configured for production.");

  let targetUrl: string;
  try {
    targetUrl = prepareInlinePreviewTarget(shape.domain);
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "URL_REJECTED",
          message:
            "Cette adresse est invalide ou vise une ressource privée. Seules les pages publiques HTTP(S) sont autorisées.",
        },
      },
      { status: 400 },
    );
  }

  const forwardedFor = request.headers.get("x-forwarded-for");
  const realIp = request.headers.get("x-real-ip")?.trim();
  const forwardedIp = forwardedFor?.split(",").at(-1)?.trim();
  const clientAddress =
    (realIp && realIp.length > 0 ? realIp : undefined) ??
    (forwardedIp && forwardedIp.length > 0 ? forwardedIp : undefined) ??
    "unknown";
  const rateKey = createHash("sha256").update(clientAddress).digest("hex");
  const quota = previewScanLimiter.hit(rateKey);
  if (!quota.allowed) {
    return NextResponse.json(
      {
        error: {
          code: "PREVIEW_RATE_LIMITED",
          message:
            "Limite de cinq audits par heure atteinte pour cette adresse. Réessayez plus tard.",
        },
      },
      { status: 429, headers: { "retry-after": String(quota.retryAfterSeconds) } },
    );
  }

  try {
    const previewResult = await executeInlinePreviewAudit(targetUrl, `preview-${randomUUID()}`);
    return NextResponse.json({
      mode: "preview_inline",
      domain: previewResult.targetUrl,
      createdAt: new Date().toISOString(),
      ...previewResult.audit,
    });
  } catch (error) {
    const rejectedTarget = isRejectedPreviewTarget(error);
    return NextResponse.json(
      {
        error: {
          code: rejectedTarget ? "URL_REJECTED" : "AUDIT_FAILED",
          message: rejectedTarget
            ? "Cette adresse est invalide ou vise une ressource privée."
            : "L’analyse n’a pas abouti. Aucun résultat n’a été inventé; réessayez ou vérifiez l’accès public à cette page.",
        },
      },
      { status: rejectedTarget ? 400 : 502 },
    );
  }
}

export async function GET(request: NextRequest) {
  const scanId = new URL(request.url).searchParams.get("scanId");
  if (!scanId) {
    return NextResponse.json(
      { error: { code: "MISSING_SCAN_ID", message: "Missing scanId parameter." } },
      { status: 400 },
    );
  }

  return proxy("GET", `/v1/public-scans/${encodeURIComponent(scanId)}`);
}
