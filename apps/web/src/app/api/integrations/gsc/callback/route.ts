export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// ─── Google OAuth redirect receiver (BFF tunnel) ───
// Google redirects the user's browser HERE (the registered redirect_uri).
// This route forwards `code`/`state`/`error` verbatim to the control plane,
// which validates the single-use server-held state + PKCE and exchanges the
// code. No secret is involved on this side: the client secret, the verifier
// and the token exchange live ONLY in the control plane, and the response it
// returns carries status/ids — never token material.

const API_URL = process.env.API_URL ?? "http://localhost:3001";

export async function GET(request: NextRequest): Promise<Response> {
  const query = request.nextUrl.search;
  let res: Response;
  try {
    res = await fetch(`${API_URL.replace(/\/+$/, "")}/v1/gsc/oauth/callback${query}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "AUDIT_SERVICE_UNAVAILABLE",
          message:
            "The control plane is unreachable. The Google grant was not consumed — retry the connection.",
        },
      },
      { status: 503 },
    );
  }
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
