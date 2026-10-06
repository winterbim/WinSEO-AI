// ─── Server-side API helper (BFF) ───
// Dashboard pages are React Server Components: they fetch the control plane
// DURING SSR, forwarding the browser's session cookie, so the HTML contains
// real persisted data (no client-side mock, no fixture).

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const API_URL = (process.env.API_URL ?? "http://localhost:3001").replace(/\/+$/, "");

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function sessionCookie(): Promise<string> {
  const jar = await cookies();
  const token = jar.get("serpvera_session")?.value;
  return token ? `serpvera_session=${token}` : "";
}

/**
 * Fetch the control plane with the browser's session forwarded.
 * 401 → redirect to /login (auth guard for every dashboard page).
 * Other non-2xx → ApiError (pages render an error state).
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const cookie = await sessionCookie();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(cookie ? { cookie } : {}),
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
    cache: "no-store",
  });

  if (res.status === 401) {
    redirect("/login");
  }

  const body = (await res.json().catch(() => null)) as T | null;
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? ((body as { error: { message?: string } | null }).error?.message ??
          res.statusText)
        : res.statusText;
    throw new ApiError(res.status, message);
  }
  if (body === null) {
    throw new ApiError(res.status, "Empty response from control plane");
  }
  return body;
}

/** True when a session cookie exists (cheap gate before calling the API). */
export async function hasSessionCookie(): Promise<boolean> {
  const cookie = await sessionCookie();
  return cookie.length > 0;
}