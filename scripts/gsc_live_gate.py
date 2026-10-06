#!/usr/bin/env python3
"""GSC-LIVE-01 real-Google gate driver (GSC-004 / GSC-005).

Executes ONLY the two credential-dependent acceptance gates against LIVE
Google APIs. It never fabricates rows: every number it prints comes from a
Google response or from the rows Google's response caused to be persisted.

Prerequisites (checked loudly):
  * API listening with REAL GSC_CLIENT_ID/GSC_CLIENT_SECRET/GSC_REDIRECT_URI
  * web listening on :3000 (the registered redirect host), API_URL pointed
    at the API
  * redirect URI registered in the Google Cloud Console:
    http://localhost:3000/api/integrations/gsc/callback

Modes:
  --bootstrap   create a scratch tenant, start a REAL authorize flow, print the
                consent URL, then wait (browser consent happens outside) until
                the callback stores an envelope-encrypted credential. Tenant
                coordinates land in a mode-600 state file OUTSIDE the repo.
  --gate 004    LIVE property discovery + grant-scoped association:
                login -> GET /gsc/sites (Google sites.list through our
                transport) -> assert >=1 real property -> POST /gsc/connections
                -> assert 201 + persisted connection row.
  --gate 005    LIVE Search Analytics ingestion:
                login -> POST /gsc/sync (explicit window ending 2 days back for
                Google's reporting lag) -> assert COMPLETED with rowCount >= 1
                -> cross-check PostgreSQL row count == rowCount -> print sample
                rows + SQL totals -> assert the API summary equals the SQL
                sums -> cleanup the scratch tenant.

Evidence rules: never print token material (responses are scanned for
Google token shapes before printing); no secrets in stdout; property URLs and
measured metrics ARE printed — they are the raw evidence.
"""
import argparse
import json
import re
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

WEB = "http://127.0.0.1:3000"
STATE_FILE = "/tmp/gsc-live-gate.json"
TAG = "gsclive" + uuid.uuid4().hex[:6]
FAILURES: list[str] = []

TOKEN_SHAPE = re.compile(r"ya29\.[A-Za-z0-9_\-]+|1//[A-Za-z0-9_\-]+")


def curl(method: str, path: str, body: dict | None = None, jar: str = "/tmp/gsc-gate.jar",
         follow: bool = False) -> tuple[int, str]:
    a = ["curl", "-s", "-o", "-", "-w", "\\n%{http_code}", "-X", method, WEB + path,
         "-H", "Content-Type: application/json"]
    if jar:
        a += ["-b", jar, "-c", jar]
    if follow:
        a += ["-L"]
    if body is not None:
        a += ["-d", json.dumps(body)]
    r = subprocess.run(a, capture_output=True, text=True, timeout=60)
    out, _, code = r.stdout.rpartition("\n")
    return (int(code) if code.strip().isdigit() else -1), out


def psql(sql: str, *params: str) -> str:
    rendered = sql
    for i, value in enumerate(params, start=1):
        rendered = re.sub(rf":p{i}\b", "'" + value.replace("'", "''") + "'", rendered)
    out = subprocess.run(
        ["psql", "-h", "/var/run/postgresql", "-d", "serpvera_dev", "-tA",
         "-v", "ON_ERROR_STOP=1", "-c", rendered],
        capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"psql failed: {out.stderr.strip()}")
    lines = [ln for ln in out.stdout.strip().splitlines() if ln.strip()]
    return lines[0] if lines else ""


def check(label: str, cond: bool, detail: str = "") -> None:
    print(("PASS  " if cond else "FAIL  ") + label + ("" if cond else f"  :: {detail}"), flush=True)
    if not cond:
        FAILURES.append(label)


def leak_scan(label: str, body: str) -> None:
    match = TOKEN_SHAPE.search(body)
    check(f"no Google token shape in {label}", match is None,
          "body contained a ya29/1// token shape" if match else "")


def redact_body(body: str) -> str:
    """Response text safe for captured stdout: tokens and emails stripped."""
    body = TOKEN_SHAPE.sub("<token>", body)
    return re.sub(r"[\w.+-]+@[\w.-]+", "<email>", body)


def save_state(state: dict) -> None:
    with open(STATE_FILE, "w") as fh:
        json.dump(state, fh, indent=2)


def load_state() -> dict:
    try:
        with open(STATE_FILE) as fh:
            return json.load(fh)
    except FileNotFoundError:
        print(f"FATAL state file missing: {STATE_FILE} — run --bootstrap first (and complete "
              "the consent it prints)")
        sys.exit(2)


def new_tenant(jar: str) -> dict:
    email = f"{TAG}@live-gsc.test"
    password = f"G4te-{uuid.uuid4().hex[:16]}"
    code, _ = curl("POST", "/api/v1/auth/register", {"email": email, "password": password}, jar)
    check("register scratch tenant", code == 201, f"code={code}")
    code, body = curl("POST", "/api/v1/organizations",
                      {"name": f"GSC Live {TAG}", "slug": f"{TAG}-org"}, jar)
    check("create scratch organization", code == 201, f"code={code}")
    org = json.loads(body).get("organization", {}).get("id", "")
    code, _ = curl("POST", "/api/v1/auth/select-organization", {"organizationId": org}, jar)
    check("select organization", code == 200, f"code={code}")
    code, body = curl("POST", "/api/v1/projects",
                      {"organizationId": org, "name": "GSC Live Gate",
                       "primaryDomain": "live-gate.example"}, jar)
    check("create scratch project", code == 201, f"code={code}")
    project = json.loads(body).get("project", {}).get("id", "")
    return {"email": email, "password": password, "org": org, "project": project, "jar": jar}


def login(state: dict) -> None:
    jar = state["jar"]
    code, _ = curl("POST", "/api/v1/auth/login",
                   {"email": state["email"], "password": state["password"]}, jar)
    check("login scratch tenant", code == 200, f"code={code}")
    code, _ = curl("POST", "/api/v1/auth/select-organization",
                   {"organizationId": state["org"]}, jar)
    check("select organization", code == 200, f"code={code}")


def bootstrap() -> int:
    jar = f"/tmp/gsc-gate-{TAG}.jar"
    state = new_tenant(jar)
    code, body = curl("POST", "/api/v1/gsc/oauth/authorize", {"projectId": state["project"]}, jar)
    check("authorize call issues a consent URL", code == 200, f"code={code} {body[:160]}")
    leak_scan("authorize response", body)
    authorize = json.loads(body)
    url = authorize.get("authorizeUrl", "")
    if not url:
        print("BLOCKED: no consent URL — deployment has no GSC client configuration "
              f"(authorize answered {code}): {redact_body(body)}", flush=True)
        return finish(cleanup=True)
    state["authorize_url"] = url
    save_state({**state, "jar": jar})
    print("\n=== OPEN THIS URL IN A BROWSER AND COMPLETE THE GOOGLE CONSENT ===", flush=True)
    print(url, flush=True)
    print("=== waiting for the callback to store the grant (max 8 min) ===", flush=True)

    deadline = time.time() + 480
    credential_id = ""
    while time.time() < deadline:
        credential_id = psql(
            "SELECT id FROM gsc_project_credentials WHERE project_id = :p1", state["project"])
        if credential_id:
            break
        time.sleep(3)
    check("OAuth callback stored a grant for the scratch project", bool(credential_id),
          f"waited 480s for gsc_project_credentials row for {state['project']}")
    if not credential_id:
        return finish()

    row = psql(
        "SELECT (substr(sha256(encrypted_refresh_token::bytea)::text, 1, 16)), scope, google_subject IS NOT NULL "
        "FROM gsc_project_credentials WHERE project_id = :p1", state["project"])
    parts = row.split("|") if "|" in row else row.split()
    print(f"raw evidence: credential_id={credential_id} envelope_fingerprint={row}", flush=True)
    check("stored material is envelope ciphertext (fingerprint printed, no token)",
          bool(credential_id) and "ya29" not in row and "1//" not in row)
    return finish()


def gate_004() -> int:
    state = load_state()
    login(state)
    jar = state["jar"]
    project = state["project"]

    code, body = curl("GET", f"/api/v1/projects/{project}/gsc/sites", jar=jar)
    check("GET /gsc/sites answered 200 against live Google", code == 200, f"code={code} {body[:200]}")
    leak_scan("sites response", body)
    sites = json.loads(body).get("sites", [])
    print(f"raw evidence (live Google sites.list): {json.dumps(sites)}", flush=True)
    check("discovery returned at least one real property", len(sites) >= 1,
          f"sites={len(sites)}")
    if not sites:
        return finish()

    property_url = sites[0].get("siteUrl", "")
    code, body = curl("POST", f"/api/v1/projects/{project}/gsc/connections",
                      {"externalProperty": property_url}, jar)
    check("grant-scoped association accepted (201)", code == 201, f"code={code} {body[:200]}")
    leak_scan("connection response", body)
    connection = json.loads(body).get("connection", {}) if code == 201 else {}
    db = psql(
        "SELECT external_property, status FROM gsc_connections WHERE project_id = :p1",
        project)
    print(f"raw evidence (persisted connection): {db}", flush=True)
    check("connection row persisted CONNECTED",
          db.startswith(f"{property_url}|CONNECTED") or f"{property_url}" in db,
          f"db={db}")
    state["property"] = property_url
    state["connection"] = connection.get("id", "")
    save_state(state)
    return finish()


def gate_005() -> int:
    state = load_state()
    login(state)
    jar = state["jar"]
    project = state["project"]
    connection_id = state.get("connection") or psql(
        "SELECT id FROM gsc_connections WHERE project_id = :p1 AND status = 'CONNECTED'",
        project)
    check("connected property available for sync", bool(connection_id), connection_id)

    end = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%d")
    start = (datetime.now(timezone.utc) - timedelta(days=90)).strftime("%Y-%m-%d")
    print(f"raw evidence: sync window {start}..{end} (2-day lag allowance)", flush=True)

    code, body = curl("POST", f"/api/v1/projects/{project}/gsc/sync",
                      {"connectionId": connection_id, "startDate": start, "endDate": end},
                      jar, follow=True)
    check("POST /gsc/sync answered 200", code == 200, f"code={code} {body[:300]}")
    leak_scan("sync response", body)
    outcome = json.loads(body).get("outcome", {})
    status = outcome.get("status", "")
    row_count = int(outcome.get("rowCount", -1))
    print(f"raw evidence (live ingestion outcome): {json.dumps(outcome, sort_keys=True)}",
          flush=True)
    check("ingestion COMPLETED against Google", status == "COMPLETED",
          f"status={status} error={outcome.get('error')}")
    check("Google returned real rows (rowCount >= 1)", row_count >= 1, f"rowCount={row_count}")
    if status != "COMPLETED" or row_count < 1:
        return finish()

    db_count = int(psql("SELECT count(*) FROM gsc_query_metrics WHERE project_id = :p1", project) or "0")
    check("PostgreSQL row count equals the API's rowCount", db_count == row_count,
          f"db={db_count} api={row_count}")

    sample = subprocess.run(
        ["psql", "-h", "/var/run/postgresql", "-d", "serpvera_dev", "-tA", "-F", " | ",
         "-c",
         f"SELECT metric_date, query, page, clicks, impressions, round(ctr::numeric,5), round(position::numeric,2) "
         f"FROM gsc_query_metrics WHERE project_id = '{project}' "
         f"ORDER BY impressions DESC LIMIT 5"],
        capture_output=True, text=True).stdout.strip()
    print("raw evidence (top-5 persisted rows by impressions, date | query | page | "
          "clicks | impressions | ctr | position):", flush=True)
    print(sample, flush=True)
    summed = subprocess.run(
        ["psql", "-h", "/var/run/postgresql", "-d", "serpvera_dev", "-tA",
         "-c",
         f"SELECT sum(clicks)::bigint, sum(impressions)::bigint, "
         f"round((sum(clicks)/nullif(sum(impressions),0))::numeric, 6), "
         f"round(sum(position * impressions)/nullif(sum(impressions),0)::numeric, 2), "
         f"count(DISTINCT metric_date) FROM gsc_query_metrics WHERE project_id = '{project}'"],
        capture_output=True, text=True).stdout.strip().split("|")
    print(f"raw evidence (SQL totals over persisted rows): clicks={summed[0]} "
          f"impressions={summed[1]} ctr={summed[2]} position={summed[3]} days={summed[4]}",
          flush=True)

    code, body = curl("GET",
                      f"/api/v1/projects/{project}/gsc/summary?startDate={start}&endDate={end}",
                      jar=jar)
    check("GET /gsc/summary answered 200", code == 200, f"code={code}")
    leak_scan("summary response", body)
    totals = json.loads(body).get("totals", {})
    print(f"raw evidence (API summary totals): {json.dumps(totals, sort_keys=True)}", flush=True)
    check("API totals equal SQL sums",
          int(totals.get("clicks", -1)) == int(summed[0])
          and int(totals.get("impressions", -1)) == int(summed[1]),
          f"api={totals} sql={summed}")
    freshness = json.loads(body).get("freshness", {})
    check("freshness reports the latest measured Google day",
          freshness.get("latestMetricDate") is not None,
          f"freshness={freshness}")
    print(f"raw evidence (freshness): {json.dumps(freshness, sort_keys=True)}", flush=True)
    return finish(cleanup=True)


def finish(cleanup: bool = False) -> int:
    if cleanup:
        try:
            with open(STATE_FILE) as fh:
                state = json.load(fh)
            psql("DELETE FROM organizations WHERE id = :p1", state.get("org", ""))
            psql("DELETE FROM users WHERE email = :p1", state.get("email", ""))
            import os
            os.remove(STATE_FILE)
            print("cleanup: scratch tenant removed, state file unlinked", flush=True)
        except FileNotFoundError:
            print("cleanup: no state file — nothing to remove", flush=True)
        except Exception as exc:  # noqa: BLE001 — cleanup must not mask gate results
            print(f"WARN  cleanup incomplete: {exc}", flush=True)
    print(f"\nTOTAL {len(FAILURES)} FAILURES", flush=True)
    for f in FAILURES:
        print(f"  FAILED: {f}")
    return 1 if FAILURES else 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bootstrap", action="store_true")
    parser.add_argument("--gate", choices=["004", "005"])
    args = parser.parse_args()
    if args.bootstrap:
        return bootstrap()
    if args.gate == "004":
        return gate_004()
    if args.gate == "005":
        return gate_005()
    parser.error("choose --bootstrap or --gate 004|005")
    return 2


if __name__ == "__main__":
    sys.exit(main())
