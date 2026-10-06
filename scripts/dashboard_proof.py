#!/usr/bin/env python3
"""PHASE-3-UI production-path proof.

Boots nothing itself — assumes BOTH servers are already running:
  API : PORT=3001 STORE_DRIVER=postgres
  Web : port 3000 with API_URL=http://localhost:3001

Everything goes through the REAL browser-facing surface over TCP:
  register (BFF proxy) -> org -> select -> project -> crawl -> poll
  -> SSR HTML of /dashboard, overview, findings, detail, crawl history
  -> auth guard redirect when no session.

Asserts the SSR HTML contains PERSISTED data (finding titles, rule ids,
sha256 evidence hashes, gate names) — not shells, not fixtures.
Exit 0 = every check passed. Also cleans up its own rows via admin psql.
"""
import json
import re
import subprocess
import sys
import time
import uuid

WEB = "http://127.0.0.1:3000"
TAG = "dash" + uuid.uuid4().hex[:8]
JAR = f"/tmp/{TAG}.jar"
FAILURES: list[str] = []


def curl(method: str, path: str, body: dict | None = None, jar: bool = True,
         follow: bool = False) -> tuple[int, str]:
    a = ["curl", "-s", "-o", "-", "-w", "\\n%{http_code}", "-X", method, WEB + path,
         "-H", "Content-Type: application/json"]
    if jar:
        a += ["-b", JAR, "-c", JAR]
    if follow:
        a += ["-L"]
    if body is not None:
        a += ["-d", json.dumps(body)]
    r = subprocess.run(a, capture_output=True, text=True)
    out, _, code = r.stdout.rpartition("\n")
    return (int(code) if code.strip().isdigit() else -1), out


def dom_text(html: str) -> str:
    """Strip React SSR comment separators (<!-- -->) — they sit between static
    text and interpolated expressions, so 'sha256: <!-- -->abc' is really the
    visible text 'sha256: abc'. Users never see them; assertions must not."""
    return re.sub(r"<!--.*?-->", "", html, flags=re.S)


def check(label: str, cond: bool, detail: str = "") -> None:
    print(("PASS  " if cond else "FAIL  ") + label + ("" if cond else f"  :: {detail}"))
    if not cond:
        FAILURES.append(label)


def psql(sql: str) -> str:
    out = subprocess.run(
        ["psql", "-h", "/var/run/postgresql", "-d", "serpvera_dev", "-tA",
         "-P", "pager=off", "-c", sql],
        capture_output=True, text=True,
        env={"PATH": "/usr/bin:/bin", "PSQL_PAGER": "cat"},
    )
    return out.stdout.strip()


def main() -> int:
    subprocess.run(["rm", "-f", JAR])

    # ── 1. Onboarding entirely through the BFF proxy ──
    email = f"{TAG}@proof.local"
    code, body = curl("POST", "/api/v1/auth/register",
                      {"email": email, "password": "dashboard-proof-pw"})
    check("register via BFF proxy -> 201", code == 201, f"{code} {body[:200]}")

    code, body = curl("POST", "/api/v1/organizations",
                      {"name": f"Proof Org {TAG}", "slug": f"proof-{TAG}"})
    check("create organization -> 201", code == 201, f"{code} {body[:200]}")
    org_id = json.loads(body)["organization"]["id"]

    code, body = curl("POST", "/api/v1/auth/select-organization",
                      {"organizationId": org_id})
    check("select organization -> 200 (tenant active)", code == 200, f"{code}")

    code, body = curl("POST", "/api/v1/projects",
                      {"organizationId": org_id, "primaryDomain": "example.com",
                       "name": "Proof Project"})
    check("create project -> 201", code == 201, f"{code} {body[:200]}")
    pid = json.loads(body)["project"]["id"]

    # ── 2. Trigger a REAL crawl and wait for persisted rows ──
    code, body = curl("POST", f"/api/v1/projects/{pid}/crawl-runs")
    check("trigger crawl -> 201", code == 201, f"{code} {body[:200]}")

    finding_id = ""
    action_id = ""
    for _ in range(30):
        time.sleep(0.5)
        code, body = curl("GET", f"/api/v1/projects/{pid}/findings")
        if code == 200:
            rows = json.loads(body).get("findings", [])
            if rows:
                finding_id = rows[0]["id"]
                action_code, action_body = curl("GET", f"/api/v1/projects/{pid}/actions")
                if action_code == 200:
                    actions = json.loads(action_body).get("actions", [])
                    if actions and actions[0].get("evidence"):
                        action_id = actions[0]["id"]
                        break
    check("findings persisted after crawl", bool(finding_id), body[:200])
    check("evidence-backed action persisted after crawl", bool(action_id), body[:200])

    # ── 3. SSR pages contain the REAL persisted data ──
    code, html = curl("GET", "/dashboard")
    check("GET /dashboard -> 200 SSR", code == 200, str(code))
    check("project list shows the real domain", "example.com" in html,
          "domain missing from SSR HTML")

    code, html = curl("GET", f"/dashboard/{pid}")
    check("overview -> 200 SSR", code == 200, str(code))
    check("overview shows a REAL finding title", "viewport" in html.lower()
          or "meta description" in html.lower() or "canonical" in html.lower(),
          "no known finding title in overview HTML")
    check("overview states OBSERVED doctrine (no score)", "OBSERVED" in html
          and "score" in html.lower(), "expected OBSERVED + no-score statement")
    check("overview shows honest intervention state",
          "No intervention verified yet" in html, html[:300])

    code, html = curl("GET", f"/dashboard/{pid}/findings")
    check("findings table -> 200 SSR", code == 200, str(code))
    check("table renders real rule provenance", "ONPAGE." in html or "TECH." in html,
          "no rule ids in findings HTML")
    check("table shows evidence class column", "Evidence" in html, "missing column")

    code, raw = curl("GET", f"/dashboard/{pid}/findings/{finding_id}")
    html = dom_text(raw)
    check("finding detail -> 200 SSR", code == 200, str(code))
    check("detail shows verification gate", "recrawl_rule_absent" in html,
          "gate missing from detail HTML")
    check("detail shows sha256 evidence hash", re.search(
        r"sha256:\s*[0-9a-f]{64}", html) is not None, "no evidence hash in HTML")
    check("detail shows affected URL", "https://example.com/" in html,
          "affected URL missing")
    check("detail shows rule version provenance", "v1.1.0" in html,
          "rule version missing")

    code, html = curl("GET", f"/dashboard/{pid}/actions")
    check("Action Center list -> 200 SSR", code == 200, str(code))
    check("Action Center renders persisted action", "DETECTED" in html and
          ("ONPAGE." in html or "TECH." in html), "action state/rule missing")
    check("Action Center declares deterministic outcome doctrine",
          "declared gate" in html and "aggregate SEO score" in html,
          "gate/no-score doctrine missing")

    code, raw = curl("GET", f"/dashboard/{pid}/actions/{action_id}")
    html = dom_text(raw)
    check("Action detail -> 200 SSR", code == 200, str(code))
    check("Action detail exposes gate and evidence hash",
          "recrawl_rule_absent" in html and re.search(
              r"sha256:\s*[0-9a-f]{64}", html) is not None,
          "gate/evidence hash missing")
    check("Action detail exposes controlled transition UI",
          "Confirm linked evidence" in html and "Before · baseline" in html and
          "Verification timeline" in html, "workflow controls/timeline missing")

    code, body = curl("POST", f"/api/v1/actions/{action_id}/transitions",
                      {"expectedVersion": 1, "toState": "EVIDENCED"})
    check("Action transition DETECTED -> EVIDENCED over TCP", code == 200,
          f"{code} {body[:200]}")
    code, body = curl("POST", f"/api/v1/actions/{action_id}/transitions", {
        "expectedVersion": 2,
        "toState": "PROPOSED",
        "recommendation": {
            "summary": "Add the deterministic markup required by the finding.",
            "rationale": "The persisted evidence demonstrates the defect.",
            "verificationGate": {"type": "recrawl_rule_absent", "spec": {}},
        },
    })
    check("Action transition EVIDENCED -> PROPOSED over TCP", code == 200,
          f"{code} {body[:200]}")

    code, html = curl("GET", f"/dashboard/{pid}/actions/{action_id}")
    check("Proposed Action detail -> 200 SSR", code == 200, str(code))
    check("Proposed action exposes approve and reject controls",
          "Approve explicitly" in html and "Reject recommendation" in html,
          "approval controls missing")

    code, body = curl("POST", f"/api/v1/actions/{action_id}/transitions", {
        "expectedVersion": 3,
        "toState": "REJECT_PROPOSAL",
        "approvalDecision": "REJECT",
        "note": "Proof rejection: narrow the recommendation before approval.",
    })
    rejected = json.loads(body).get("action", {}) if code == 200 else {}
    history = rejected.get("history", [])
    check("Explicit recommendation rejection returns to EVIDENCED with audit trail",
          code == 200 and rejected.get("state") == "EVIDENCED" and history and
          history[-1].get("payload", {}).get("approvalDecision") == "REJECT",
          f"{code} {body[:300]}")

    code, html = curl("GET", f"/dashboard/{pid}/crawls")
    check("crawl history -> 200 SSR", code == 200, str(code))
    check("history shows the completed run", "completed" in html and "HTTP_FAST" in html,
          "run rows missing")

    # ── 4. Auth guard: no session -> redirect to /login ──
    r = subprocess.run(
        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code} %{redirect_url}",
         WEB + "/dashboard"],
        capture_output=True, text=True,
    )
    out = r.stdout.strip()
    check("GET /dashboard without session redirects to /login",
          out[:2] == "30" and "/login" in out, out)

    # ── 5. Cleanup (admin cascade: org -> projects/findings/evidence/actions) ──
    psql(f"DELETE FROM users WHERE email = '{email}';")
    deleted = psql(f"DELETE FROM organizations WHERE name = 'Proof Org {TAG}';")
    check("proof rows cleaned up (org cascade)", deleted.startswith("DELETE"), deleted)

    print(f"\nFAILURES={len(FAILURES)}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    subprocess.run(["rm", "-f", JAR])
    try:
        sys.exit(main())
    finally:
        subprocess.run(["rm", "-f", JAR])
