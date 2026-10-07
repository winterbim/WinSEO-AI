// ─── Generic BFF proxy for client-side mutations ───
// Forwards any /api/v1/* request (method, query, JSON body, session cookie) to
// the control plane and relays status + Set-Cookie + body back to the browser.
// Authorisation and business logic live ONLY in the control plane; this route
// is a dumb fixed-target tunnel (API_URL is operator config, never user input).

const API_URL = (process.env.API_URL ?? "http://localhost:3001").replace(/\/+$/, "");

async function forward(method: string, request: Request, path: string[]): Promise<Response> {
  const url = new URL(request.url);
  const target = `${API_URL}/v1/${path.join("/")}${url.search}`;
  const cookie = request.headers.get("cookie") ?? undefined;
  const idempotencyKey = request.headers.get("idempotency-key") ?? undefined;
  const body = method === "GET" ? undefined : await request.text();

  let res: Response;
  try {
    res = await fetch(target, {
      method,
      headers: {
        accept: "application/json",
        ...(cookie ? { cookie } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      // `??` is safe for `""` too: the JSON content-type header above is only
      // attached for truthy bodies, so an empty string reaches the control
      // plane unparsed — exactly like a missing body.
      body: body ?? undefined,
    });
  } catch {
    return Response.json(
      {
        error: {
          code: "AUDIT_SERVICE_UNAVAILABLE",
          message: "The service is temporarily unavailable. Please retry.",
        },
      },
      { status: 503 },
    );
  }

  const text = await res.text();
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  // Multiple Set-Cookie headers must be appended individually — joining them
  // with ", " would corrupt cookies whose Expires attribute contains commas.
  for (const sc of res.headers.getSetCookie()) {
    headers.append("set-cookie", sc);
  }
  return new Response(text, { status: res.status, headers });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await params;
  return forward("POST", request, path);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await params;
  return forward("GET", request, path);
}
