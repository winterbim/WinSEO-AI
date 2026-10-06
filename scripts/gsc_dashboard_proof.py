#!/usr/bin/env python3
"""GSC-LIVE-01 dashboard proof — the Search Performance surfaces over real SSR.

Boots nothing itself — assumes BOTH servers are already running:
  API : PORT=3001 STORE_DRIVER=postgres (GSC client env may be absent)
  Web : port 3000 with API_URL=http://localhost:3001

What it proves through the browser-facing surface over TCP:
  * /dashboard/{p}/search-performance renders PERSISTED gsc_query_metrics rows
    (totals, daily series, connection state, freshness) — the seeded rows are
    deterministic measured fixtures standing in for a Google sync, and the
    assertions demand those exact values back, unmodified.
  * queries / pages breakdowns render measured dimension rows.
  * opportunities / changes render MEASURED recommendations with dataset
    window, filters, comparison window, observed values and the verification
    gate.
  * the Action Center detail surface renders the GSC before/after section.
  * a project without GSC rows gets the honest empty/connect state — never
    synthesized numbers.

Asserts SSR HTML contains the seeded values. Exit 0 = every check passed.
Cleans up its own rows via admin psql (organizations cascade).
"""
import json
import re
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone

WEB = "http://127.0.0.1:3000"
TAG = "gscui" + uuid.uuid4().hex[:8]
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
    """Strip React SSR comment separators so 'sha256: <!-- -->abc' matches the
    visible text users see."""
    return re.sub(r"<!--.*?-->", "", html, flags=re.S)


def check(label: str, cond: bool, detail: str = "") -> None:
    print(("PASS  " if cond else "FAIL  ") + label + ("" if cond else f"  :: {detail}"))
    if not cond:
        FAILURES.append(label)


def q(value: str) -> str:
    """SQL-quote a script-generated value (identifiers/dates/numbers/literals)."""
    return "'" + value.replace("'", "''") + "'"


def psql(sql: str, *params: str) -> str:
    rendered = sql
    for i, value in enumerate(params, start=1):
        rendered = re.sub(rf":p{i}\b", q(value).replace("\\", "\\\\"), rendered)
    out = subprocess.run(
        ["psql", "-h", "/var/run/postgresql", "-d", "serpvera_dev", "-tA",
         "-v", "ON_ERROR_STOP=1", "-c", rendered],
        capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"psql failed: {out.stderr.strip()}")
    # `-c` prints the command tag (e.g. "INSERT 0 1") after RETURNING rows.
    lines = [line for line in out.stdout.strip().splitlines() if line.strip()]
    return lines[0] if lines else ""


def day(offset: int) -> str:
    """UTC calendar day at `offset` from today (0 = today)."""
    return (datetime.now(timezone.utc) + timedelta(days=offset)).strftime("%Y-%m-%d")


def money(n: int) -> str:
    return f"{n:,}"


def main() -> int:
    # Windows mirror the API's default: 28 days ending yesterday; the
    # comparison window is the 28 days immediately before it.
    end = day(-1)
    start = day(-28)
    b_end = day(-29)
    b_start = day(-56)
    mid1 = day(-21)
    mid2 = day(-20)
    b_mid = day(-39)

    # ── Tenant, org, two projects (one with measurements, one empty) ──
    code, _ = curl("POST", "/api/v1/auth/register", {
        "email": f"{TAG}@test.local", "password": "gsc-dashboard-pw-1"})
    check("register accepts a fresh account", code == 201, f"code={code}")
    code, body = curl("POST", "/api/v1/organizations",
                      {"name": f"GSC UI {TAG}", "slug": f"{TAG}-org"})
    check("organization created", code == 201, f"code={code}")
    org_id = json.loads(body).get("organization", {}).get("id", "") if code == 201 else ""
    code, _ = curl("POST", "/api/v1/auth/select-organization", {"organizationId": org_id})
    check("organization selected", code == 200, f"code={code}")

    code, body = curl("POST", "/api/v1/projects",
                      {"organizationId": org_id, "name": "GSC UI Site",
                       "primaryDomain": "example.com"})
    check("project created", code == 201, f"code={code}")
    project = json.loads(body).get("project", {}).get("id", "") if code == 201 else ""
    code, body = curl("POST", "/api/v1/projects",
                      {"organizationId": org_id, "name": "GSC UI Empty",
                       "primaryDomain": "empty.example.org"})
    empty_project = json.loads(body).get("project", {}).get("id", "") if code == 201 else ""
    check("empty project created", code == 201 and bool(empty_project), f"code={code}")

    # ── Seed deterministic MEASURED fixtures exactly as ingestion would ──
    # (A real deployment gets these rows from GSC sync; the UI contract is that
    # it renders whatever was measured, byte-for-byte, and nothing else.)
    conn_id = psql(
        "INSERT INTO gsc_connections (organization_id, project_id, external_property,"
        " scope, credential_ref, status, connected_at, last_sync_at)"
        " VALUES (:p1, :p2, 'sc-domain:example.com', 'sc-domain', 'cred-ui', 'CONNECTED',"
        " now(), now()) RETURNING id",
        org_id, project)
    job_id = psql(
        "INSERT INTO gsc_sync_jobs (organization_id, project_id, connection_id,"
        " window_start, window_end, status, row_count, completed_at)"
        " VALUES (:p1, :p2, :p3, :p4::date, :p5::date, 'COMPLETED', 5, now()) RETURNING id",
        org_id, project, conn_id, b_start, end)
    rows = [
        # query/page pair that trips high_impressions_low_ctr + ranking_opportunity
        (mid1, "gsc demo query", "https://example.com/demo", 3, 900, 0.003333, 7.2),
        (mid2, "gsc demo query", "https://example.com/demo", 2, 800, 0.0025, 7.8),
        # baseline + current of a winner (changes surface)
        (b_mid, "gsc winner query", "https://example.com/winner", 2, 400, 0.005, 5.0),
        (mid1, "gsc winner query", "https://example.com/winner", 40, 900, 0.044444, 3.0),
        # baseline + current of a decay
        (b_mid, "gsc decay query", "https://example.com/decay", 60, 1200, 0.05, 4.0),
        (mid2, "gsc decay query", "https://example.com/decay", 9, 300, 0.03, 9.0),
    ]
    for (d, q, page, clicks, impr, ctr, pos) in rows:
        psql(
            "INSERT INTO gsc_query_metrics (organization_id, project_id, sync_job_id,"
            " metric_date, query, page, country, device, clicks, impressions, ctr, position)"
            " VALUES (:p1, :p2, :p3, :p4::date, :p5, :p6, 'usa', 'DESKTOP',"
            " :p7::float8, :p8::float8, :p9::float8, :p10::float8)",
            org_id, project, job_id, d, q, page,
            str(clicks), str(impr), str(ctr), str(pos))

    try:
        run_checks(project, empty_project, start, end, b_start, b_end)
    finally:
        try:
            psql("DELETE FROM organizations WHERE id = :p1", org_id)
            psql("DELETE FROM users WHERE email = :p1", f"{TAG}@test.local")
        except Exception as cleanup_error:  # noqa: BLE001 — cleanup must not mask results
            print(f"WARN  cleanup incomplete: {cleanup_error}")

    print(f"\nTOTAL {len(FAILURES)} FAILURES")
    return 1 if FAILURES else 0


def run_checks(project: str, empty_project: str, start: str, end: str,
               b_start: str, b_end: str) -> None:
    # ── Navigation reaches the new surface ──
    code, html = curl("GET", f"/dashboard/{project}", follow=True)
    text = dom_text(html)
    check("overview links Search Performance", code == 200 and "Search Performance" in text)

    # ── Search Performance overview ──
    code, html = curl("GET", f"/dashboard/{project}/search-performance", follow=True)
    text = dom_text(html)
    check("performance page renders", code == 200, f"code={code}")
    check("performance header present", "First-party Google Search Console measurements" in text)
    check("dataset window rendered",
          f"{start} → {end}".replace(" ", "") in text.replace(" ", "") or
          (start in text and end in text), f"window {start}..{end}")
    check("connection row rendered", "sc-domain:example.com" in text and "CONNECTED" in text)
    check("sync control rendered", "Sync now" in text)
    # Totals are bound to their CARD LABELS — a stray "54" anywhere else, or a
    # wrong figure under the right label, cannot satisfy these.
    check("totals: clicks bound to its label",
          re.search(r"Clicks</p>\s*<p[^>]*>54</p>", text) is not None)
    check("totals: impressions bound to its label",
          re.search(r"Impressions</p>\s*<p[^>]*>2,900</p>", text) is not None)
    check("totals: CTR bound to its label",
          re.search(r"CTR</p>\s*<p[^>]*>1\.86%</p>", text) is not None)
    check("totals: position bound to its label",
          re.search(r"Avg\. position</p>\s*<p[^>]*>6\.25</p>", text) is not None)
    check("daily series rendered", "2026" in text and "Avg. position" in text)
    check("freshness metadata rendered", "latest measured day" in text)
    check("sync jobs surface rendered", "Synchronization jobs" in text and "COMPLETED" in text)

    # ── Queries / pages breakdowns ──
    code, html = curl("GET", f"/dashboard/{project}/search-performance/queries", follow=True)
    text = dom_text(html)
    check("queries page renders", code == 200, f"code={code}")
    check("query rows measured", "gsc demo query" in text and "gsc winner query" in text)
    # EVERY measured cell of each pinned row is bound to its row label.
    check("demo query row fully pinned",
          re.search(
              r">gsc demo query</td>\s*<td[^>]*>5</td>\s*<td[^>]*>1,700</td>"
              r"\s*<td[^>]*>0\.29%</td>\s*<td[^>]*>7\.48</td>\s*<td[^>]*>2</td>",
              text) is not None)
    check("winner query row fully pinned",
          re.search(
              r">gsc winner query</td>\s*<td[^>]*>40</td>\s*<td[^>]*>900</td>"
              r"\s*<td[^>]*>4\.44%</td>\s*<td[^>]*>3\.00</td>\s*<td[^>]*>1</td>",
              text) is not None)

    code, html = curl("GET", f"/dashboard/{project}/search-performance/pages", follow=True)
    text = dom_text(html)
    check("pages page renders", code == 200, f"code={code}")
    # Every measured cell of the pinned page rows is bound to its row label.
    check("demo page row fully pinned",
          re.search(
              r">https://example\.com/demo</td>\s*<td[^>]*>5</td>\s*<td[^>]*>1,700</td>"
              r"\s*<td[^>]*>0\.29%</td>\s*<td[^>]*>7\.48</td>\s*<td[^>]*>2</td>",
              text) is not None)
    check("winner page row fully pinned",
          re.search(
              r">https://example\.com/winner</td>\s*<td[^>]*>40</td>\s*<td[^>]*>900</td>"
              r"\s*<td[^>]*>4\.44%</td>\s*<td[^>]*>3\.00</td>\s*<td[^>]*>1</td>",
              text) is not None)

    # ── Opportunities: MEASURED contract rendered ──
    code, html = curl("GET", f"/dashboard/{project}/search-performance/opportunities", follow=True)
    text = dom_text(html)
    check("opportunities page renders", code == 200, f"code={code}")
    check("opportunity is MEASURED", "MEASURED" in text)
    check("low-CTR opportunity found", "Low CTR for" in text)
    check("ranking window found", "inside the opportunity window" in text)
    check("dataset window on card", "Dataset window" in text)
    check("filters on card", "Filters" in text)
    check("verification gate on card", "Verification gate" in text and "gsc_window" in text)
    check("observed values on card", "Observed" in text)
    check("promote-to-action control", "Open in Action Center" in text)

    # ── Changes: winners + decay over the comparison window ──
    code, html = curl("GET", f"/dashboard/{project}/search-performance/changes", follow=True)
    text = dom_text(html)
    check("changes page renders", code == 200, f"code={code}")
    check("comparison window rendered",
          b_start in text and b_end in text, f"baseline {b_start}..{b_end}")
    check("winner detected", "Winner" in text and "gsc winner query" in text)
    check("decay detected", "fell" in text and "gsc decay query" in text)

    # ── Action Center before/after surface, BOTH branches ──
    code, body = curl("POST", f"/api/v1/projects/{project}/gsc/findings", {
        "module": "high_impressions_low_ctr",
        "subject": {"query": "gsc demo query", "page": "https://example.com/demo"},
        "title": "Low CTR for the demo query",
        "rationale": "UI proof promotion of a measured recommendation.",
        "datasetWindow": {"startDate": start, "endDate": end},
        "filters": {"minImpressions": 500, "maxCtr": 0.02},
        "observed": {"impressions": 1700, "clicks": 5, "ctr": 0.002941, "position": 7.482, "days": 2},
        "evidenceClass": "MEASURED",
        "verificationGate": {"type": "gsc_window", "spec": {
            "metric": "ctr", "operator": "gte", "threshold": 0.02,
            "query": "gsc demo query", "page": "https://example.com/demo",
            "minImpressions": 500, "windowDays": 30}},
        "severity": "medium",
    })
    action_id = json.loads(body).get("actionId", "") if code in (200, 201) else ""
    check("promotion opens an action", code in (200, 201) and bool(action_id),
          f"code={code} body={body[:120]}")
    if action_id:
        # Pre-gate branch first.
        code, html = curl("GET", f"/dashboard/{project}/actions/{action_id}", follow=True)
        text = dom_text(html)
        check("action detail renders GSC section", "GSC before / after (measured)" in text)
        check("gsc section explains pre-gate state", "declares no GSC gate" in text)

        # Drive the workflow to MEASURING so the measured branch renders.
        gate = {"type": "gsc_window", "spec": {
            "metric": "ctr", "operator": "gte", "threshold": 0.02,
            "query": "gsc demo query", "page": "https://example.com/demo",
            "minImpressions": 500, "windowDays": 30}}
        steps = [
            (1, {"toState": "EVIDENCED"}),
            (2, {"toState": "PROPOSED", "recommendation": {
                "summary": "Improve the demo query snippet.", "rationale": "Measured.",
                "verificationGate": gate}}),
            (3, {"toState": "APPROVED", "approvalDecision": "APPROVE"}),
            (4, {"toState": "IMPLEMENTED", "implementation": {"whatChanged": "Snippet rewritten.",
                 "how": "Release 8."}, "rollback": {"strategy": "Revert release 8."}}),
            (5, {"toState": "MEASURING", "baselineSnapshot": {"source": "gsc_query_metrics"},
                 "comparisonWindow": {"startsAt": f"{start}T00:00:00.000Z",
                                      "endsAt": f"{end}T23:59:59.000Z"}}),
        ]
        walked = True
        for version, step in steps:
            c, b = curl("POST", f"/api/v1/actions/{action_id}/transitions",
                        {"expectedVersion": version, **step})
            if c != 200:
                walked = False
                check(f"transition v{version} accepted", False, f"code={c} body={b[:120]}")
        check("workflow reaches MEASURING", walked)

        code, html = curl("GET", f"/dashboard/{project}/actions/{action_id}", follow=True)
        text = dom_text(html)
        check("measured before/after table rendered",
              "Baseline" in text and "Measured" in text and "Delta" in text)
        check("measured branch is MEASURED", "MEASURED" in text)
        check("measured branch shows windows", start in text and end in text)
        # Every cell of the table is pinned to its row label — baseline (no rows
        # for this subject before the change), the measured values, AND the
        # derived deltas — so a dummy or wrong column cannot pass.
        check("before/after pins the full clicks row",
              re.search(
                  r"clicks</td>\s*<td[^>]*>0</td>\s*<td[^>]*>5</td>\s*<td[^>]*>0\.0000</td>",
                  text) is not None)
        check("before/after pins the full impressions row",
              re.search(
                  r"impressions</td>\s*<td[^>]*>0</td>\s*<td[^>]*>1700</td>\s*<td[^>]*>0\.0000</td>",
                  text) is not None)
        check("before/after pins the full ctr row",
              re.search(
                  r"ctr</td>\s*<td[^>]*>0</td>\s*<td[^>]*>0\.002941</td>\s*<td[^>]*>—</td>",
                  text) is not None)
        check("before/after pins the full position row",
              re.search(
                  r"position</td>\s*<td[^>]*>0</td>\s*<td[^>]*>7\.482</td>\s*<td[^>]*>7\.4824</td>",
                  text) is not None)

    # ── Honest empty state on a project with zero measurements ──
    code, html = curl("GET", f"/dashboard/{empty_project}/search-performance", follow=True)
    text = dom_text(html)
    check("empty project renders", code == 200, f"code={code}")
    check("empty state is honest", "No measured Search Analytics rows" in text)
    check("connect control offered", "Connect Google Search Console" in text)
    check("empty state invents nothing",
          "gsc demo query" not in text
          and "Daily performance" not in text
          and "Avg. position" not in text)


if __name__ == "__main__":
    sys.exit(main())
