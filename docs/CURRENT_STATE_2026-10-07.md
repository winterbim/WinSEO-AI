# WinSEO Current State — 2026-10-07

## Baseline

| Claim                                                      | Test / raw evidence                                                                                                                                                                                                                             | Status                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Correct target revision was audited                        | Branch `feat/product-finish-2026`, PR #1, HEAD `937f9fb2f78df2b0cadc325e62e3943b767f9d10`; `git status --porcelain` empty before this file was created                                                                                          | EVIDENCED                                                |
| Toolchain is reproducible from the lockfile                | Node `v24.21.0` (repo `.node-version` requests 22); pnpm `9.15.0`; `pnpm install --frozen-lockfile --offline` exit 0. Root package `serpvera@0.1.0`; Next `15.5.27`, TypeScript `5.9.3`, PostgreSQL client `16.15`                              | EVIDENCED                                                |
| Type checking passes                                       | `pnpm typecheck` exit 0; Turbo reports 15/15 tasks successful                                                                                                                                                                                   | EVIDENCED                                                |
| Formatting gate passes                                     | `pnpm format:check` exit 1; 117 files reported by Prettier. GitHub run `37537993530`, job `Verify / Format check`, fails with the same 117-file baseline                                                                                        | DISPROVEN                                                |
| Lint and production build pass                             | `pnpm lint` exit 1: web lint errors in `decision-center.test.ts`, `geo-stats.test.ts`, `geo-stats.ts`; Next ESLint plugin warning and deprecated `next lint` usage. `pnpm build` compiles, then fails during the same Next lint gate            | DISPROVEN                                                |
| Tests pass when suites are run directly                    | API: 101/101 across 19 suites; web: 4/4; DB: 45/45; crawler: 124/124; authz: 2/2. Root `pnpm test` exits 1 because Turbo's prerequisite web build fails at lint before the aggregate completes                                                  | EVIDENCED (direct suites); DISPROVEN (aggregate command) |
| Database migrations apply from a clean local test database | Temporary PostgreSQL 16 cluster under `/tmp`, database `serpvera_dev`: bootstrap plus migrations `0001`–`0014` applied successfully. The machine's default PostgreSQL `16/main` cluster is down, so its pre-existing migration state is UNKNOWN | EVIDENCED (temporary DB); UNKNOWN (default DB)           |
| GitHub checks are green                                    | `gh pr checks 1`: `Verify` failed, `Security Scan` passed. Retrieved failure log shows the Format check as the first failing Verify step; later Verify steps were not reached                                                                   | DISPROVEN                                                |

## Audited product and operational gaps

| Area                    | Observed state                                                                                                                                                             | Status                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| First use               | Signup links target `/signup`, while signup is a mode on `/login`; project creation navigates to overview and does not launch the crawl although the form copy promises it | EVIDENCED                                                            |
| Decision Center         | Recommendations are assembled from real crawl/GSC signals, but some evidence links lead to an opportunities view that omits those recommendation types                     | EVIDENCED                                                            |
| AI visibility           | CSV capture and statistics run in the browser and can be downloaded; captures are not persisted or connected to project history/Decision Center                            | EVIDENCED                                                            |
| Reports                 | No report route/export path found in the audited app                                                                                                                       | EVIDENCED                                                            |
| Monitoring              | No durable scheduled monitoring/alert pipeline established; crawl requests are fire-and-forget in the API process                                                          | EVIDENCED                                                            |
| Readiness               | `/health` returns a constant success response; no separate database/migration readiness gate found                                                                         | EVIDENCED                                                            |
| Tenant data             | `finding_evidence` is not tenant-scoped/RLS-protected in migration `0004`; schema-integrity tests do not cover this table                                                  | EVIDENCED; security remediation required                             |
| GSC                     | OAuth/GSC code exists, but project-level credential uniqueness does not model multiple independent grants; no real Google credentials were used                            | EVIDENCED (schema limitation); GSC_LIVE = BLOCKED_CREDENTIALS        |
| Other external services | No live billing/email validation was attempted or represented as working                                                                                                   | BILLING_LIVE = BLOCKED_CREDENTIALS; EMAIL_LIVE = BLOCKED_CREDENTIALS |

## Source references

- Product journey review: `apps/web/src/app/dashboard/create-project-form.tsx`, `apps/api/src/routes/projects.ts`, `apps/web/src/app/login/page.tsx`.
- Decision Center and AI visibility: `apps/web/src/lib/decision-center.ts`, `apps/web/src/app/dashboard/[projectId]/search-performance/opportunities/page.tsx`, `apps/web/src/app/dashboard/[projectId]/ai-visibility/geo-csv-lab.tsx`.
- Data, RLS and migrations: `packages/db/migrations/0004_findings_scope.sql`, `packages/db/migrations/0006_gsc_scaffold.sql`, `packages/db/migrations/0007_gsc_live.sql`.
- Monitoring and health: `apps/api/src/routes/projects.ts`, API server health route/config.
- CI evidence: GitHub Actions run `37537993530` for PR #1; check `Verify` failed at `pnpm format:check`, `Security Scan` passed.

## Baseline decision

No application code was modified before collecting the baseline above. This file records the initial state and is the first repository change. It does not accept any product or production gate. The next work must address the failing CI baseline first, then close product and security gaps with isolated migrations and adversarial verification. GSC, billing, and email remain blocked until real operator configuration and external verification exist.
