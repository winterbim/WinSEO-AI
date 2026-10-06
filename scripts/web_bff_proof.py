#!/usr/bin/env python3
"""BFF end-to-end proof (P-GAP-03).

Proves the production chain: browser HTTP → Next.js BFF proxy (port 3000)
→ control-plane API (port 3001) → PostgreSQL persistence, plus the failure
mode: unreachable control plane → explicit 503, never fabricated results.

Assumes both servers are already running:
  API  : PORT=3001 STORE_DRIVER=postgres
  Web  : port 3000 with API_URL=http://localhost:3001
Exit 0 = every check passed.
"""
import json
import subprocess
import sys
import time
import urllib.request
import urllib.error

WEB = "http://127.0.0.1:3000"
FAILURES: list[str] = []


def request(method: str, path: str, body: dict | None = None) -> tuple[int, dict | str]:
    req = urllib.request.Request(
        WEB + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            code = r.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        code = e.code
    except urllib.error.URLError as e:
        return -1, str(e)
    try:
        return code, json.loads(raw)
    except json.JSONDecodeError:
        return code, raw


def check(label: str, cond: bool, detail: str = "") -> None:
    print(("PASS  " if cond else "FAIL  ") + label + ("" if cond else f"  :: {detail}"))
    if not cond:
        FAILURES.append(label)


def psql(sql: str) -> str:
    out = subprocess.run(
        ["psql", "-h", "/var/run/postgresql", "-d", "serpvera_dev",
         "-tA", "-P", "pager=off", "-c", sql],
        capture_output=True, text=True,
        env={"PATH": "/usr/bin:/bin", "PSQL_PAGER": "cat"},
    )
    return out.stdout.strip()


def main() -> int:
    # ── Degraded-mode probe: run ONLY when the control plane is DOWN ──
    if "--probe-unreachable" in sys.argv:
        code, body = request("POST", "/api/scan", {"domain": "example.org"})
        raw = json.dumps(body) if isinstance(body, dict) else str(body)
        check("unreachable control plane -> 503 with explicit error",
              code == 503 and "unreachable" in raw, f"{code} {raw}")
        check("no fabricated results in degraded response",
              "No scan was started" in raw and "scanId" not in raw, raw)
        print(f"\nFAILURES={len(FAILURES)}")
        return 1 if FAILURES else 0

    # ── 1. Real scan through the BFF proxy ──
    code, body = request("POST", "/api/scan", {"domain": "example.com"})
    scan = body if isinstance(body, dict) else {}
    check("POST /api/scan (via Next.js proxy) -> 2xx with scanId",
          200 <= code < 300 and "scanId" in scan, f"{code} {body}")
    scan_id = scan.get("scanId", "")
    if not scan_id:
        print("cannot continue without scanId")
        return 1

    # ── 2. Poll via the BFF until terminal ──
    data: dict = {}
    for _ in range(30):
        time.sleep(1)
        c, d = request("GET", f"/api/scan?scanId={scan_id}")
        if isinstance(d, dict) and d.get("status") in ("completed", "failed"):
            data = d
            break
    check("scan reached a terminal state via BFF polling",
          data.get("status") == "completed", f"status={data.get('status')}")
    findings = data.get("findings") or []
    check("scan produced real findings through the chain",
          len(findings) > 0, f"findings={len(findings)}")

    # ── 3. Persistence: the row must be in PostgreSQL (not web memory) ──
    rows = psql(
        "SELECT status||'|'||(findings::jsonb)::text FROM public_scans "
        f"WHERE id='{scan_id}';"
    )
    check("scan persisted in PostgreSQL public_scans",
          rows.startswith("completed|"), f"rows={rows[:120]!r}")

    # ── 4. SSRF enforced through the proxy (400 propagated, no scan created) ──
    code, body = request("POST", "/api/scan", {"domain": "127.0.0.1"})
    detail = body.get("error", "") if isinstance(body, dict) else str(body)
    check("SSRF through proxy -> 400 with explicit block message",
          code == 400 and "security policy" in str(detail), f"{code} {detail}")

    # ── 5. Results page renders over real HTTP ──
    # The results page is a client component: SSR emits the shell and the
    # browser then polls the BFF. Assert the shell rendered — NOT client data.
    code, html = request("GET", f"/scan/{scan_id}")
    html_s = html if isinstance(html, str) else ""
    check("GET /scan/{id} results page -> 200 HTML",
          code == 200 and "<html" in html_s.lower(), f"{code}")
    check("results page SSR shell renders (client polls for data)",
          "Loading scan" in html_s,
          "expected SSR shell with 'Loading scan' in HTML")

    # ── 6. (Degraded mode is exercised separately with --probe-unreachable
    #       after stopping the control plane.) ──
    print(f"\nFAILURES={len(FAILURES)}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
