#!/usr/bin/env python3
"""Compute transparent GEO visibility statistics from real CSV captures.

Ported from NEXUS Search Intelligence v0.1.0 — scripts/geo_stats.py
Wilson confidence intervals, mention/citation rates, domain diversity, engine divergence.

Input: CSV with columns: engine, prompt_id, brand_mentioned, client_cited, citation_domains (; separated)
Output: JSON stats per engine + per prompt
"""

import argparse
import csv
import json
import math
import sys
from collections import defaultdict, Counter


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float | None, float | None]:
    """Wilson score interval for a proportion.
    
    Returns (lower, upper) or (None, None) when n == 0.
    """
    if n == 0:
        return (None, None)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def truth(v: str) -> bool:
    """Parse boolean-like string values."""
    return str(v).strip().lower() in {"1", "true", "yes", "y"}


REQUIRED_COLS = {"engine", "prompt_id", "brand_mentioned", "client_cited"}


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Compute transparent GEO visibility statistics from real CSV captures."
    )
    ap.add_argument("csv_path", help="Path to CSV file with GEO run data")
    ap.add_argument("--json", dest="json_path", help="Write JSON output to file")
    args = ap.parse_args()

    try:
        with open(args.csv_path, encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
    except FileNotFoundError:
        print(json.dumps({"error": f"File not found: {args.csv_path}"}))
        return 1
    except Exception as e:
        print(json.dumps({"error": f"CSV read error: {e}"}))
        return 1

    if not rows:
        print(json.dumps({"error": "CSV file is empty", "input_rows": 0}))
        return 1

    # Validate columns
    available = set(reader.fieldnames or [])
    missing = REQUIRED_COLS - available
    if missing:
        print(json.dumps({"error": f"Missing required columns: {', '.join(sorted(missing))}"}))
        return 1

    has_domains = "citation_domains" in available

    # Group by engine
    groups: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        groups[r["engine"]].append(r)

    result: dict = {
        "warning": "GEO stats are stochastic measurements, not guaranteed visibility scores. Repeated runs required for stable conclusions.",
        "method": "Wilson score interval (95% CI) for mention and citation rates.",
        "input_rows": len(rows),
        "engines": {},
    }

    for engine, rs in sorted(groups.items()):
        n = len(rs)
        m = sum(truth(r["brand_mentioned"]) for r in rs)
        c = sum(truth(r["client_cited"]) for r in rs)

        domains: list[str] = []
        if has_domains:
            for r in rs:
                raw = r.get("citation_domains", "")
                domains += [d.strip().lower() for d in raw.split(";") if d.strip()]

        domain_counter = Counter(domains)
        unique_domains = len(domain_counter)

        mention_ci = wilson(m, n)
        citation_ci = wilson(c, n)

        result["engines"][engine] = {
            "runs": n,
            "mention_rate": round(m / n, 4) if n else None,
            "mention_wilson95_lower": mention_ci[0],
            "mention_wilson95_upper": mention_ci[1],
            "client_citation_rate": round(c / n, 4) if n else None,
            "client_citation_wilson95_lower": citation_ci[0],
            "client_citation_wilson95_upper": citation_ci[1],
            "unique_citation_domains": unique_domains,
            "top_citation_domains": domain_counter.most_common(15),
        }

    # Per-prompt breakdown if multiple prompts exist
    prompt_groups: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        key = f"{r['engine']}::{r['prompt_id']}"
        prompt_groups[key].append(r)

    if len(prompt_groups) > len(groups):
        result["prompts"] = {}
        for key, prs in sorted(prompt_groups.items()):
            engine, pid = key.split("::", 1)
            n = len(prs)
            m = sum(truth(r["brand_mentioned"]) for r in prs)
            c = sum(truth(r["client_cited"]) for r in prs)
            ci = wilson(m, n)
            cci = wilson(c, n)
            result["prompts"][key] = {
                "engine": engine,
                "prompt_id": pid,
                "runs": n,
                "mention_rate": round(m / n, 4) if n else None,
                "mention_wilson95_lower": ci[0],
                "mention_wilson95_upper": ci[1],
                "client_citation_rate": round(c / n, 4) if n else None,
                "client_citation_wilson95_lower": cci[0],
                "client_citation_wilson95_upper": cci[1],
            }

    output = json.dumps(result, ensure_ascii=False, indent=2)

    if hasattr(args, "json_path") and args.json_path:
        with open(args.json_path, "w", encoding="utf-8") as f:
            f.write(output + "\n")

    print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())