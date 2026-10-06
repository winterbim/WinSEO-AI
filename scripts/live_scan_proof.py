#!/usr/bin/env python3
"""Live product proof: real scan of a real public domain through the production API path.

Boots nothing itself — assumes the API server is already listening on $API_BASE.
POSTs /v1/public-scans, polls GET /v1/public-scans/{id} until completed,
asserts real findings exist, prints evidence. Exit 0 = product promise proven.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

BASE = os.environ.get("API_BASE", "http://127.0.0.1:3011")
DOMAIN = os.environ.get("SCAN_DOMAIN", "example.com")


def post(path, payload):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=20) as r:
        return json.loads(r.read().decode())


def main():
    print(f"[1] POST /v1/public-scans domain={DOMAIN}")
    created = post("/v1/public-scans", {"domain": DOMAIN})
    scan_id = created.get("scanId")
    assert scan_id, f"no scanId: {created}"
    print(f"    scanId={scan_id} status={created.get('status')}")

    print("[2] poll until terminal")
    data = None
    for _ in range(30):
        time.sleep(1)
        data = get(f"/v1/public-scans/{scan_id}")
        if data.get("status") in ("completed", "failed"):
            break
    assert data, "no data"
    print(f"    status={data['status']} findings={len(data.get('findings', []))}")

    print("[3] assert real findings produced by real HTTP fetch")
    findings = data.get("findings", [])
    if data["status"] != "completed":
        print(json.dumps(data, indent=2)[:2000])
        return 1
    assert findings, "completed scan produced ZERO findings — not a real product result"
    for f in findings:
        rid = f.get("ruleId")
        sev = f.get("severity")
        cls = f.get("epistemicClass")
        urls = f.get("affectedUrls", [])
        print(f"    - {rid} [{sev}] [{cls}] -> {urls[0] if urls else '?'}")
        assert cls == "OBSERVED", f"finding {rid} must be OBSERVED, got {cls}"
        assert urls, f"finding {rid} has no affected URLs — not traceable evidence"

    print("[4] evidence traceability")
    evidence = data.get("evidence", [])
    assert evidence, "no evidence items — findings without evidence violate the doctrine"
    for e in evidence:
        print(f"    - {e.get('kind')} @ {e.get('sourceRef')} ({e.get('capturedAt')})")

    print(f"LIVE PROOF OK: {len(findings)} finding(s), {len(evidence)} evidence item(s), domain={DOMAIN}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (urllib.error.URLError, AssertionError) as exc:
        print(f"LIVE PROOF FAILED: {exc}")
        sys.exit(1)
