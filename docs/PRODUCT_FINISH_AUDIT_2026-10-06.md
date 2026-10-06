# WinSEO product-finish audit — 2026-10-06

## Executive finding

WinSEO already had a strong evidence-first technical core. The main product gap was not infrastructure. It was product orchestration: crawl evidence, Search Console intelligence, Action Center, and the existing GEO statistics existed as separate capabilities without one decision surface that explained what to do next.

This change does not clone any third-party product. It keeps WinSEO's own doctrine: **observed facts, measured first-party data, explicit evidence classes, human approval, reversible change, and verification gates**.

## What was already strong

- PostgreSQL persistence and tenant isolation with RLS.
- Server-held sessions, MFA and secure GSC OAuth/token handling.
- SSRF-protected crawling and deterministic SEO rules.
- Evidence ledger with content hashes and source references.
- Search Console ingestion and deterministic intelligence modules.
- Action Center with approval/measurement/verification state.
- Proven-patch workflow and rollback semantics.
- A GEO statistics module using repeated captures and Wilson intervals.
- CI, security checks, proof ledger and skeptic review artifacts.

## Product gaps found

1. **No unified decision queue.** Users had Findings, Actions and GSC Opportunities, but no single surface joining observed defects with measured growth opportunities.
2. **GEO capability was not productized.** The repository had a Python statistics engine, but no dashboard workflow for real AI-answer capture data.
3. **The UI still looked like a collection of expert modules.** The user had to infer the sequence between crawl, Search Console, action and verification.
4. **There must remain no synthetic global SEO score.** The existing evidence doctrine is a differentiator and should not be weakened for marketing simplicity.
5. **Content pruning must remain a review decision.** Cannibalization evidence can recommend a consolidation review, but WinSEO must not auto-delete or auto-redirect a page based on traffic alone.

## Product contract

WinSEO classifies statements before acting:

| Class | Meaning | Allowed source |
| --- | --- | --- |
| OBSERVED | Direct fact of a fetched/rendered document | Crawl/evidence |
| MEASURED | Numeric result from persisted first-party or captured data | GSC / repeated AI-answer captures |
| DOCUMENTED | Supported by a named external primary source | Documentation |
| INFERRED | Reasoned interpretation of evidence | Analysis layer |
| HYPOTHESIS | Testable explanation awaiting verification | Decision layer |
| UNKNOWN | Insufficient evidence | Explicit empty/block state |

No surface should silently convert one class into another.

## Product flow

```text
CRAWL + GSC + AI CAPTURES
          |
          v
      EVIDENCE
          |
          v
   DECISION CENTER
    /    |      \
 FIX   GROW   REFRESH / CONSOLIDATE REVIEW
          |
          v
      ACTION CENTER
          |
          v
  APPROVE -> CHANGE -> VERIFY
          |
          v
       HISTORY
```

## Delivered in this branch

### Decision Center

New route:

`/dashboard/:projectId/decision-center`

It combines:

- open crawl findings as **OBSERVED**;
- Search Console intelligence as **MEASURED**;
- deterministic lanes: Fix now, Grow, Refresh, Consolidate review, Watch;
- explicit empty/blocked states;
- no global score;
- links back to the underlying evidence.

The lane is a workflow recommendation, not a claim about a search engine ranking algorithm.

### AI Visibility Lab

New route:

`/dashboard/:projectId/ai-visibility`

It accepts captured CSV rows:

```csv
engine,prompt_id,brand_mentioned,client_cited,citation_domains
```

It calculates per-engine:

- number of captured runs;
- brand mention rate;
- client citation rate;
- 95% Wilson confidence interval;
- citation-domain diversity;
- top cited domains.

The feature explicitly treats generative answers as stochastic repeated samples. It does not create a fake "GEO score" and does not claim that one prompt result is a stable ranking.

## Ideas intentionally not copied

The implementation does **not** reproduce another tool's:
- page design;
- wording;
- pricing;
- lead-capture funnel;
- scoring model;
- report format;
- brand;
- API contract.

The reusable insight is the product problem, not the implementation: users need clear decisions from evidence, and AI visibility needs repeated measurement.

## Remaining external gates before production launch

These are not code-completion claims:

- Real Google Search Console OAuth credentials and one real authorized property are still required to prove live GSC gates that are currently BLOCKED in the proof ledger.
- Production infrastructure must provide the documented PostgreSQL, secrets, HTTPS and API environment.
- Automated AI-engine capture requires an explicitly approved provider integration. Until then, the AI Visibility Lab deliberately accepts real captured CSV data rather than simulating responses.
- Billing, legal/privacy text, production monitoring and incident operations should be launch-gated separately if WinSEO will be sold publicly.

## Definition of "finished"

For this repository, "finished" means the core product has a coherent operational path and honest states. It does **not** mean external credentials or third-party services are fabricated to make every integration look live.
