# NEXUS Provenance

> **Traceability record.** Documents which WinSEO components derive from NEXUS Search Intelligence.

**Source:** `winterbim/Next.-SEO-geo-@bim` — NEXUS Search Intelligence v0.1.0
**Audit date:** 2026-10-02
**Migration phase:** NEXUS-IMPORT-00 through NEXUS-IMPORT-04

## Components with NEXUS Lineage

| WinSEO Path | NEXUS Origin | Type | Notes |
|---|---|---|---|
| `packages/authz/src/priority-engine.ts` | `scripts/opportunity_rank.py` | FORMULA ADAPTED | Formula updated to safe denominator; TypeScript rewrite |
| `packages/contracts/src/evidence-validator.ts` | `scripts/evidence_lint.py` | PORTED | Full TypeScript reimplementation with test parity |
| `services/nexus-engine/geo-stats/geo_stats.py` | `scripts/geo_stats.py` | KEPT PYTHON | Wilson intervals, domain diversity; operational as CLI microservice |
| `services/nexus-engine/geo-stats/GEO_LAB.md` | `workflows/geo-lab.md` | ADAPTED | Protocol document for AI Search measurements |
| `packages/contracts/src/schemas/finding-v1.schema.json` | `schemas/finding-v1.schema.json` | PORTED | Extended with WinSEO fields; NEXUS core preserved |
| `packages/contracts/src/schemas/geo-run-v1.schema.json` | `schemas/geo-run-v1.schema.json` | PORTED | AI engine observation schema |
| `packages/contracts/src/schemas/experiment-v1.schema.json` | `schemas/experiment-v1.schema.json` | PORTED | Controlled experiment schema |
| `docs/references/` | `references/` | ARCHIVED | Knowledge documents preserved as reference |
| `docs/NEXUS_MIGRATION_MATRIX.md` | — | WinSEO original | Migration audit trail |

## Doctrine Preserved Intact

1. Epistemic classification: OBSERVED / MEASURED / DOCUMENTED / INFERRED / HYPOTHESIS / UNKNOWN
2. Anti-hallucination: INFERRED/HYPOTHESIS/UNKNOWN cannot be EVIDENCED as fact
3. Source hierarchy: A1 (first-party) through E (anecdotal)
4. Unsupported GEO claims blacklist (source-policy.md)
5. Citation selection ≠ citation absorption
6. Repeated AI runs required for stable visibility conclusions
7. WinCreator proof discipline: CLAIM → TEST → EVIDENCE → SKEPTIC → VERDICT

## What Was Rejected

| NEXUS Component | Reason |
|---|---|
| `scripts/http_probe.py` | WinSEO crawler (`services/crawler/`) is strictly more capable (SSRF guard, redirect chains, content hashing) |
| `SKILL.md`, `README.md`, `CHANGELOG.md` | Cursor-specific; WinSEO Blueprint is the authority |
| `agents/openai.yaml` | Cursor agent config; not relevant |
| `workflows/local-search.md` | Deferred to Phase 8 (Agency scale) |
| `workflows/benchmark.md` | Deferred post-V1 |
| `scripts/package_check.py` | WinSEO has its own CI (`turbo verify`) |

---

*This file establishes intellectual lineage. WinSEO/SERPVERA is a new product that incorporates and extends NEXUS methodology. NEXUS remains acknowledged as the domain kernel origin.*