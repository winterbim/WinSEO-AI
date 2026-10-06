#!/usr/bin/env python3
"""End-to-end HTTP verification against the REAL production execution path.

Why this exists separately from the Node test suites:
  apps/api/src/*.test.ts drive Fastify via app.inject(), which bypasses the network
  stack, cookie handling over the wire, and the real listener. This harness starts
  nothing itself — it talks to an already-running server over TCP, so it exercises
  the same code path production does.

Requires:
  - serpvera_dev migrated (node packages/db/src/migrate.ts)
  - API server listening:
      cd apps/api && AUTH_SECRET=<min-16-chars> STORE_DRIVER=postgres PORT=3011 \
        npx tsx src/server.ts
Run:
  python3 scripts/e2e_http_verification.py [--base http://127.0.0.1:3011]

Exits non-zero if any check fails. Prints PASS/FAIL per check.
Self-cleaning: deletes the tenants it creates.
"""

from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
import uuid

FAILURES: list[str] = []


def curl(args: list[str]) -> tuple[int, str]:
    r = subprocess.run(
        ["curl", "-sS", "-w", "\n%{http_code}", *args],
        capture_output=True,
        text=True,
    )
    out, _, code = r.stdout.rpartition("\n")
    return (int(code) if code.strip().isdigit() else -1), out


def request(base: str, method: str, path: str, jar: str | None = None,
            body: dict | None = None, raw_cookie: str | None = None) -> tuple[int, dict]:
    a = ["-X", method, base + path, "-H", "Content-Type: application/json"]
    if jar:
        a += ["-b", jar, "-c", jar]
    if raw_cookie:
        a += ["-H", f"cookie: {raw_cookie}"]
    if body is not None:
        a += ["-d", json.dumps(body)]
    code, raw = curl(a)
    try:
        return code, (json.loads(raw) if raw else {})
    except json.JSONDecodeError:
        # Non-JSON body (e.g. a proxy/HTML error): keep it visible for diagnosis
        # but never treat it as a valid API response.
        return code, {"_non_json_body": raw[:500]}


def check(label: str, cond: bool, detail: str = "") -> bool:
    print(("PASS  " if cond else "FAIL  ") + label + ("" if cond else f"  :: {detail}"))
    if not cond:
        FAILURES.append(label)
    return bool(cond)


def forge_cookie(payload: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:3011")
    args = ap.parse_args()
    base = args.base.rstrip("/")
    tag = "e2e" + uuid.uuid4().hex[:8]

    jar_a = f"/tmp/{tag}_a.jar"
    jar_b = f"/tmp/{tag}_b.jar"
    for j in (jar_a, jar_b):
        subprocess.run(["rm", "-f", j])

    ids: dict[str, str] = {}

    try:
        # ── 1. Liveness over the real network ──
        c, b = request(base, "GET", "/health")
        check("GET /health over real TCP returns 200", c == 200, f"{c} {b}")

        # ── 2. Tenant A onboarding ──
        email_a, pw_a = f"a_{tag}@e2e.local", "e2e-password-A1"
        c, b = request(base, "POST", "/v1/auth/register", jar_a,
                       {"email": email_a, "password": pw_a})
        check("register A -> 201", c == 201, f"{c} {b}")

        c, b = request(base, "POST", "/v1/organizations", jar_a,
                       {"name": f"Alpha {tag}", "slug": f"alpha-{tag}"})
        check("create org A -> 201", c == 201, f"{c} {b}")
        ids["org_a"] = b.get("organization", {}).get("id", "")

        # ── 3. Unauthenticated access is refused ──
        c, b = request(base, "GET", "/v1/organizations/00000000-0000-4000-8000-000000000000")
        check("unauthenticated org read -> 401 UNAUTHORIZED",
              c == 401 and b.get("error", {}).get("code") == "UNAUTHORIZED", f"{c} {b}")

        # ── 4. Tenant context is server-derived via membership ──
        c, b = request(base, "POST", "/v1/auth/select-organization", jar_a,
                       {"organizationId": ids["org_a"]})
        check("select-organization A -> 200 with server-derived OWNER role",
              c == 200 and b.get("tenant", {}).get("role") == "OWNER", f"{c} {b}")

        c, b = request(base, "POST", "/v1/projects", jar_a,
                       {"organizationId": ids["org_a"],
                        "primaryDomain": f"{tag}.example.com", "name": "E2E Site"})
        check("create project A -> 201", c == 201, f"{c} {b}")
        ids["proj_a"] = b.get("project", {}).get("id", "")

        c, _ = request(base, "GET", f"/v1/projects/{ids['proj_a']}", jar_a)
        check("owner reads own project -> 200", c == 200, str(c))

        # ── 5. Tenant B ──
        c, b = request(base, "POST", "/v1/auth/register", jar_b,
                       {"email": f"b_{tag}@e2e.local", "password": "e2e-password-B1"})
        check("register B -> 201", c == 201, f"{c} {b}")
        c, b = request(base, "POST", "/v1/organizations", jar_b,
                       {"name": f"Beta {tag}", "slug": f"beta-{tag}"})
        ids["org_b"] = b.get("organization", {}).get("id", "")
        check("create org B -> 201", c == 201, f"{c} {b}")
        request(base, "POST", "/v1/auth/select-organization", jar_b,
                {"organizationId": ids["org_b"]})

        # ── 6. Cross-tenant denial (the core security property) ──
        c, b = request(base, "GET", f"/v1/projects/{ids['proj_a']}", jar_b)
        check("CROSS-TENANT project read -> 404 (RLS, not an app-level filter)",
              c == 404, f"{c} {b}")
        check("cross-tenant response leaks no project name",
              "E2E Site" not in json.dumps(b), json.dumps(b))

        c, _ = request(base, "GET", f"/v1/organizations/{ids['org_a']}", jar_b)
        check("CROSS-TENANT org read -> 404 (uniform; no existence oracle)", c == 404, str(c))

        c, _ = request(base, "POST", "/v1/auth/select-organization", jar_b,
                       {"organizationId": ids["org_a"]})
        check("B CANNOT select-organization into A -> 404", c == 404, str(c))

        # ── 7. Forged cookie (session integrity) ──
        forged = "serpvera_session=" + forge_cookie(
            {"userId": "x", "email": f"b_{tag}@e2e.local", "organizationId": ids["org_a"]})
        c, b = request(base, "GET", f"/v1/projects/{ids['proj_a']}", None, None, forged)
        check("forged/unsigned session cookie -> 401",
              c == 401 and b.get("error", {}).get("code") == "UNAUTHORIZED", f"{c} {b}")

        # ── 8. SSRF over the real wire (no row must be persisted) ──
        for bad in ["127.0.0.1", "localhost", "10.0.0.1", "192.168.1.1",
                    "169.254.169.254", "172.16.0.1", "100.64.0.1"]:
            c, b = request(base, "POST", "/v1/public-scans", None, {"domain": bad})
            check(f"SSRF pre-queue block: {bad} -> 400 SSRF_BLOCKED",
                  c == 400 and b.get("error", {}).get("code") == "SSRF_BLOCKED", f"{c} {b}")

        # ── 9. Validation errors are opaque ──
        c, b = request(base, "POST", "/v1/organizations", jar_a,
                       {"name": "Bad", "slug": "BAD_slug!"})
        body = json.dumps(b)
        check("invalid slug -> 400 VALIDATION_ERROR (not 500)",
              c == 400 and b.get("error", {}).get("code") == "VALIDATION_ERROR", f"{c} {body}")
        check("no Zod internals leaked (regex/pattern/issue codes)",
              "a-z0-9" not in body and "invalid_format" not in body, body)

        c, b = request(base, "POST", "/v1/projects", jar_a,
                       {"organizationId": "not-a-uuid", "primaryDomain": "x.example.com"})
        check("malformed org id -> 400 VALIDATION_ERROR (not 500)",
              c == 400 and b.get("error", {}).get("code") == "VALIDATION_ERROR", f"{c} {b}")

    finally:
        # ── Cleanup: remove created tenants (orgs cascade to projects/memberships) ──
        print("\n[cleanup] removing created rows from serpvera_dev ...")
        sql = (
            f"DELETE FROM organizations WHERE slug IN ('alpha-{tag}','beta-{tag}'); "
            f"DELETE FROM users WHERE email LIKE '%{tag}@e2e.local';"
        )
        subprocess.run(["psql", "-d", "serpvera_dev", "-q", "-c", sql])
        for j in (jar_a, jar_b):
            subprocess.run(["rm", "-f", j])

    print(f"\nFAILURES={len(FAILURES)}")
    for f in FAILURES:
        print(" - " + f)
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
