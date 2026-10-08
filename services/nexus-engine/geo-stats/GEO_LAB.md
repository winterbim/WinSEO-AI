# GEO Laboratory Protocol

Ported from NEXUS Search Intelligence v0.1.0 — `workflows/geo-lab.md`

## 1. Define Scope

Each measurement starts with:

- Engine(s) and exact product surfaces defined independently
- Locale/language
- Prompt clusters derived from customer jobs-to-be-done

## 2. Build Prompt Matrix

Categories:

- Category discovery ("best X for Y")
- Comparison/alternatives ("X vs Y")
- Problem/solution ("how to fix X")
- Local/provider selection ("X near me")
- Validation/trust ("X reviews")
- Product/service detail
- High-intent purchase/contact
- Post-purchase/support when relevant

For each intent: preserve canonical prompt + controlled paraphrases. Track language, locale, persona and funnel stage.

## 3. Freeze & Execute

- Freeze client brand name/domain/aliases
- Freeze competitor set
- Execute repeated observations (recommended: 7+ per prompt/engine combination)
- Preserve raw captures where permitted

## 4. Record Per Run

- Timestamp and locale
- Exact prompt
- Engine/product/version label when exposed
- Answer text (or permitted structured capture)
- Brand mentions (positions)
- Cited URLs/domains and order
- Source class (owned, competitor, earned_media, forum, institution, other)
- Citation absorption assessment
- Retrieval/search mode when observable
- Errors and non-responses

## 5. Compute Statistics

Use `geo_stats.py`:

- Mention rate with Wilson 95% CI
- Citation rate with Wilson 95% CI
- Citation-domain diversity
- Top citation domains
- Per-prompt breakdown

## 6. Interpret (Conservative)

- **No data ≠ zero** — engines not measured must show `NOT_MEASURED`
- **A single observation is not proof of visibility**
- **Compare paraphrases, engines, languages and dates separately**
- **Do not merge engine results into one unexplained score**

## 7. Diagnose Failures by Stage

Absence of a citation can come from:

1. Discovery — engine doesn't know the page exists
2. Retrieval — page not in retrieval index
3. Source selection — page not chosen as a source
4. Citation — page cited but not absorbed
5. Brand mention — brand mentioned but page not linked

Targeted interventions beat generic rewriting.

## 8. Re-measure

After changes: re-run identical frozen prompt matrix. Compare before/after with the same statistical framework. Report uncertainty and alternative explanations.
