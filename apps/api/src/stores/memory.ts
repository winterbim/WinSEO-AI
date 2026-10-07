// ─── In-memory API stores ───
// TEST-ONLY / local smoke adapter. NOT used in production.
// Retained because unit tests (tenant-isolation.test.ts) run without PostgreSQL;
// they exercise application-level authz. Database-level tenant isolation is
// proven separately by packages/db RLS tests against real PostgreSQL.
// Production wiring selects the DB store — see createStores.ts and server.ts.

import { randomUUID } from "node:crypto";
import type { OrgRole } from "@serpvera/contracts";
import type {
  ApiStores,
  EvidenceInput,
  StoredFinding,
  StoredOrganization,
  StoredProject,
  StoredPublicScan,
  StoredSession,
  StoredUser,
  MfaRecord,
} from "./types.ts";
import { DuplicateEmailError, DuplicateSlugError } from "./types.ts";
import { ActionMutationError, GscMeasurementWorkflowAdvancedError } from "@serpvera/db";
import { createRateLimiter, type RateLimitScope } from "../rate-limit.ts";
import type { PatchProposal } from "../autofix/workflow.ts";

export function createMemoryStores(): ApiStores {
  const users = new Map<string, StoredUser>();
  const orgs = new Map<string, StoredOrganization>();
  // `${userId}:${orgId}` -> role
  const memberships = new Map<string, OrgRole>();
  const projects = new Map<string, StoredProject>();
  const projectIdempotency = new Map<
    string,
    { name: string; primaryDomain: string; project: StoredProject }
  >();
  const scans = new Map<string, StoredPublicScan>();
  const sessionRecords = new Map<string, StoredSession & { revokedAt: Date | null }>();
  const mfaRecords = new Map<string, MfaRecord>();
  const rateLimiters = new Map<string, ReturnType<typeof createRateLimiter>>();
  // P-GAP-04: tenant-scoped crawl state (memory adapter = test driver only)
  const crawlRuns = new Map<
    string,
    {
      organizationId: string;
      projectId: string;
      status: string;
      pagesCrawled: number;
      pagesFailed: number;
      mode: string;
      startedAt: string;
      completedAt: string | null;
    }
  >();
  const crawlFindings: (StoredFinding & { organizationId: string; projectId: string })[] = [];
  const crawlEvidence: (EvidenceInput & {
    id: string;
    organizationId: string;
    projectId: string;
    createdAt: string;
  })[] = [];
  const findingEvidenceLinks: { findingId: string; evidenceId: string }[] = [];
  const actionRecords = new Map<
    string,
    { id: string; organizationId: string; projectId: string; findingId: string; state: string }
  >();
  const patchRecords = new Map<
    string,
    {
      organizationId: string;
      projectId: string;
      proposal: PatchProposal;
      fixtureHtml: string;
      eventCount: number;
    }
  >();

  // The in-memory driver is a SYNCHRONOUS test double behind the async
  // ApiStores contract: methods return explicitly resolved promises instead of
  // carrying a hollow `async` keyword (require-await), while throws stay sync
  // (every call site awaits inside try/catch, which observes both identically).
  return {
    users: {
      createUser(email, passwordHash, name) {
        const normalized = email.toLowerCase();
        for (const u of users.values()) {
          if (u.email === normalized) throw new DuplicateEmailError();
        }
        const user: StoredUser = {
          id: randomUUID(),
          email: normalized,
          passwordHash,
          name: name ?? null,
        };
        users.set(user.id, user);
        return Promise.resolve(user);
      },
      findByEmail(email) {
        const normalized = email.toLowerCase();
        for (const u of users.values()) if (u.email === normalized) return Promise.resolve(u);
        return Promise.resolve(null);
      },
      findById(id) {
        return Promise.resolve(users.get(id) ?? null);
      },
    },

    orgs: {
      createOrganization(ownerUserId, name, slug) {
        for (const o of orgs.values()) if (o.slug === slug) throw new DuplicateSlugError();
        const org: StoredOrganization = { id: randomUUID(), name, slug };
        orgs.set(org.id, org);
        memberships.set(`${ownerUserId}:${org.id}`, "OWNER");
        return Promise.resolve(org);
      },
      getForRequester(userId, organizationId) {
        if (!memberships.has(`${userId}:${organizationId}`)) return Promise.resolve(null);
        return Promise.resolve(orgs.get(organizationId) ?? null);
      },
      getRoleForUser(userId, organizationId) {
        return Promise.resolve(memberships.get(`${userId}:${organizationId}`) ?? null);
      },
      listForUser(userId) {
        return Promise.resolve(
          [...orgs.values()].filter((o) => memberships.has(`${userId}:${o.id}`)),
        );
      },
    },

    projects: {
      createProject(organizationId, name, primaryDomain) {
        const project: StoredProject = {
          id: randomUUID(),
          organizationId,
          name,
          primaryDomain,
        };
        projects.set(project.id, project);
        return Promise.resolve(project);
      },
      createProjectWithIdempotencyKey(organizationId, name, primaryDomain, idempotencyKey) {
        const idempotencyScope = `${organizationId}:${idempotencyKey}`;
        const existing = projectIdempotency.get(idempotencyScope);
        if (existing) {
          if (existing.name !== name || existing.primaryDomain !== primaryDomain) {
            return Promise.resolve({ kind: "conflict" as const });
          }
          return Promise.resolve({ kind: "replayed" as const, project: existing.project });
        }

        const project: StoredProject = {
          id: randomUUID(),
          organizationId,
          name,
          primaryDomain,
        };
        projects.set(project.id, project);
        projectIdempotency.set(idempotencyScope, { name, primaryDomain, project });
        return Promise.resolve({ kind: "created" as const, project });
      },
      getProject(organizationId, projectId) {
        const p = projects.get(projectId);
        // Emulate RLS: foreign-tenant read yields null (no existence leak).
        if (p?.organizationId !== organizationId) return Promise.resolve(null);
        return Promise.resolve(p);
      },
      listProjects(organizationId) {
        return Promise.resolve(
          [...projects.values()].filter((p) => p.organizationId === organizationId),
        );
      },
    },

    scans: {
      createPublicScan(domain) {
        const scan: StoredPublicScan = {
          id: randomUUID(),
          domain,
          status: "pending",
          createdAt: new Date().toISOString(),
          completedAt: null,
          findings: [],
          evidence: [],
          error: null,
        };
        scans.set(scan.id, scan);
        return Promise.resolve(scan);
      },
      getPublicScan(id) {
        return Promise.resolve(scans.get(id) ?? null);
      },
      markRunning(id) {
        const s = scans.get(id);
        if (s) s.status = "running";
        return Promise.resolve();
      },
      updateResult(id, status, findings, evidence, error) {
        const s = scans.get(id);
        if (!s) return Promise.resolve();
        s.status = status;
        s.findings = findings;
        s.evidence = evidence;
        s.error = error ?? null;
        s.completedAt = new Date().toISOString();
        return Promise.resolve();
      },
    },

    rateLimits: {
      hit(ip, limitPerWindow, scope: RateLimitScope = "public-scan-ip") {
        const key = `${scope}:${limitPerWindow}`;
        let limiter = rateLimiters.get(key);
        if (!limiter) {
          limiter = createRateLimiter(limitPerWindow);
          rateLimiters.set(key, limiter);
        }
        return Promise.resolve(limiter.hit(ip, scope));
      },
    },

    sessions: {
      create(tokenHash, userId, email, expiresAt, organizationId, role) {
        sessionRecords.set(tokenHash, {
          userId,
          email,
          expiresAt,
          organizationId,
          role,
          revokedAt: null,
        });
        return Promise.resolve();
      },
      get(tokenHash) {
        const r = sessionRecords.get(tokenHash);
        if (!r || r.revokedAt || r.expiresAt.getTime() <= Date.now()) return Promise.resolve(null);
        const { revokedAt: _revoked, ...session } = r;
        return Promise.resolve(session);
      },
      setOrg(tokenHash, organizationId, role) {
        const r = sessionRecords.get(tokenHash);
        if (r && !r.revokedAt) {
          r.organizationId = organizationId;
          r.role = role;
          delete r.stepUpVerifiedAt;
          delete r.stepUpMfaCounter;
        }
        return Promise.resolve();
      },
      setStepUp(tokenHash, verifiedAt, counter) {
        const r = sessionRecords.get(tokenHash);
        if (r && !r.revokedAt) {
          r.stepUpVerifiedAt = verifiedAt;
          r.stepUpMfaCounter = counter;
        }
        return Promise.resolve();
      },
      revoke(tokenHash) {
        const r = sessionRecords.get(tokenHash);
        if (r) r.revokedAt = new Date();
        return Promise.resolve();
      },
      revokeAllForUser(userId) {
        let n = 0;
        for (const r of sessionRecords.values()) {
          if (r.userId === userId && !r.revokedAt) {
            r.revokedAt = new Date();
            n++;
          }
        }
        return Promise.resolve(n);
      },
    },

    mfa: {
      get(userId) {
        const record = mfaRecords.get(userId);
        return Promise.resolve(record ? structuredClone(record) : null);
      },
      beginEnrollment(userId, encryptedSecret, expiresAt) {
        const current = mfaRecords.get(userId);
        if (current?.enabledAt) return Promise.resolve(false);
        mfaRecords.set(userId, {
          encryptedSecret,
          enabledAt: null,
          enrollmentExpiresAt: expiresAt,
          lastCounter: -1,
        });
        return Promise.resolve(true);
      },
      confirmEnrollment(userId, counter) {
        const current = mfaRecords.get(userId);
        if (
          !current ||
          current.enabledAt ||
          !current.enrollmentExpiresAt ||
          Date.parse(current.enrollmentExpiresAt) <= Date.now() ||
          current.lastCounter >= counter
        )
          return Promise.resolve(false);
        current.enabledAt = new Date().toISOString();
        current.enrollmentExpiresAt = null;
        current.lastCounter = counter;
        return Promise.resolve(true);
      },
      consumeCounter(userId, counter) {
        const current = mfaRecords.get(userId);
        if (!current?.enabledAt || current.lastCounter >= counter) return Promise.resolve(false);
        current.lastCounter = counter;
        return Promise.resolve(true);
      },
      disable(userId, counter) {
        const current = mfaRecords.get(userId);
        if (!current?.enabledAt || current.lastCounter >= counter) return Promise.resolve(false);
        mfaRecords.delete(userId);
        return Promise.resolve(true);
      },
    },

    crawl: {
      createCrawlRun(organizationId, projectId, mode) {
        const id = randomUUID();
        crawlRuns.set(id, {
          organizationId,
          projectId,
          status: "running",
          pagesCrawled: 0,
          pagesFailed: 0,
          mode,
          startedAt: new Date().toISOString(),
          completedAt: null,
        });
        return Promise.resolve({ id });
      },
      finishCrawlRun(organizationId, runId, status, pagesCrawled, pagesFailed) {
        const run = crawlRuns.get(runId);
        // Emulate RLS: a foreign tenant cannot update (or even see) the run.
        if (run?.organizationId === organizationId) {
          run.status = status;
          run.pagesCrawled = pagesCrawled;
          run.pagesFailed = pagesFailed;
          run.completedAt = new Date().toISOString();
        }
        return Promise.resolve();
      },
      listCrawlRuns(organizationId, projectId) {
        return Promise.resolve(
          [...crawlRuns.entries()]
            .filter(([, r]) => r.organizationId === organizationId && r.projectId === projectId)
            .sort((a, b) => b[1].startedAt.localeCompare(a[1].startedAt))
            .map(([id, r]) => ({
              id,
              status: r.status,
              mode: r.mode,
              startedAt: r.startedAt,
              completedAt: r.completedAt,
              pagesCrawled: r.pagesCrawled,
              pagesFailed: r.pagesFailed,
            })),
        );
      },
      addFinding(organizationId, projectId, finding) {
        const id = randomUUID();
        crawlFindings.push({
          id,
          organizationId,
          projectId,
          ruleId: finding.ruleId,
          ruleVersion: finding.ruleVersion,
          title: finding.title,
          epistemicClass: finding.epistemicClass,
          severity: finding.severity,
          status: "open",
          confidence: 1,
          explanation: finding.explanation,
          recommendation: finding.recommendation,
          firstSeenAt: new Date().toISOString(),
          affectedUrls: finding.affectedUrls,
          verificationGate: finding.verificationGate,
        });
        return Promise.resolve({ id });
      },
      addEvidence(organizationId, projectId, evidence) {
        const id = randomUUID();
        crawlEvidence.push({
          id,
          organizationId,
          projectId,
          createdAt: new Date().toISOString(),
          ...evidence,
        });
        return Promise.resolve({ id });
      },
      createMeasuredGscWorkflow(organizationId, projectId, finding, evidence) {
        let storedFinding = crawlFindings.find(
          (row) =>
            row.organizationId === organizationId &&
            row.projectId === projectId &&
            row.ruleId === finding.ruleId &&
            row.status !== "resolved",
        );
        const created = !storedFinding;
        if (!storedFinding) {
          storedFinding = {
            id: randomUUID(),
            organizationId,
            projectId,
            ruleId: finding.ruleId,
            ruleVersion: finding.ruleVersion,
            title: finding.title,
            epistemicClass: finding.epistemicClass,
            severity: finding.severity,
            status: "open",
            confidence: 1,
            explanation: finding.explanation,
            recommendation: finding.recommendation,
            firstSeenAt: new Date().toISOString(),
            affectedUrls: finding.affectedUrls,
            verificationGate: finding.verificationGate,
          };
          crawlFindings.push(storedFinding);
        }

        let action = [...actionRecords.values()].find(
          (row) =>
            row.organizationId === organizationId &&
            row.projectId === projectId &&
            row.findingId === storedFinding.id,
        );
        let storedEvidence = findingEvidenceLinks
          .filter((link) => link.findingId === storedFinding.id)
          .map((link) => crawlEvidence.find((row) => row.id === link.evidenceId))
          .find((row) => row?.kind === "gsc_data");
        const updated = Boolean(
          storedEvidence && storedEvidence.contentHash !== evidence.contentHash,
        );
        if (updated && action && action.state !== "DETECTED" && action.state !== "EVIDENCED") {
          throw new GscMeasurementWorkflowAdvancedError();
        }
        if (!storedEvidence || updated) {
          const id = randomUUID();
          storedEvidence = {
            id,
            organizationId,
            projectId,
            createdAt: new Date().toISOString(),
            ...evidence,
          };
          crawlEvidence.push(storedEvidence);
          findingEvidenceLinks.push({ findingId: storedFinding.id, evidenceId: id });
          if (updated) {
            Object.assign(storedFinding, {
              ruleVersion: finding.ruleVersion,
              title: finding.title,
              epistemicClass: finding.epistemicClass,
              severity: finding.severity,
              explanation: finding.explanation,
              recommendation: finding.recommendation,
              affectedUrls: finding.affectedUrls,
              verificationGate: finding.verificationGate,
            });
          }
        }

        if (!action) {
          const id = randomUUID();
          action = {
            id,
            organizationId,
            projectId,
            findingId: storedFinding.id,
            state: "DETECTED",
          };
          actionRecords.set(id, action);
        }
        return Promise.resolve({
          created,
          updated,
          findingId: storedFinding.id,
          evidenceId: storedEvidence.id,
          actionId: action.id,
        });
      },
      listFindings(organizationId, projectId) {
        return Promise.resolve(
          crawlFindings
            .filter((f) => f.organizationId === organizationId && f.projectId === projectId)
            .map(({ organizationId: _o, projectId: _p, ...rest }) => ({
              ...rest,
              actionState:
                [...actionRecords.values()].find((a) => a.findingId === rest.id)?.state ?? null,
            })),
        );
      },
      getFinding(organizationId, findingId) {
        const f = crawlFindings.find(
          (x) => x.organizationId === organizationId && x.id === findingId,
        );
        if (!f) return Promise.resolve(null);
        const { organizationId: _o, projectId: _p, ...rest } = f;
        const evidenceIds = findingEvidenceLinks
          .filter((l) => l.findingId === findingId)
          .map((l) => l.evidenceId);
        return Promise.resolve({
          ...rest,
          projectId: f.projectId,
          actionState:
            [...actionRecords.values()].find((a) => a.findingId === findingId)?.state ?? null,
          evidence: crawlEvidence
            .filter((e) => evidenceIds.includes(e.id))
            .map((e) => ({
              id: e.id,
              kind: e.kind,
              sourceRef: e.sourceRef,
              contentHash: e.contentHash,
              objectKey: e.objectKey,
              capturedAt: e.createdAt,
              metadata: e.metadata ?? {},
            })),
        });
      },
      linkFindingEvidence(_organizationId, findingId, evidenceId) {
        if (
          !findingEvidenceLinks.some(
            (l) => l.findingId === findingId && l.evidenceId === evidenceId,
          )
        ) {
          findingEvidenceLinks.push({ findingId, evidenceId });
        }
        return Promise.resolve();
      },
      listEvidence(organizationId, projectId) {
        return Promise.resolve(
          crawlEvidence
            .filter((e) => e.organizationId === organizationId && e.projectId === projectId)
            .map((e) => ({
              id: e.id,
              kind: e.kind,
              sourceRef: e.sourceRef,
              contentHash: e.contentHash,
              objectKey: e.objectKey,
              capturedAt: e.createdAt,
              metadata: e.metadata ?? {},
            })),
        );
      },
      createDetectedAction(organizationId, projectId, findingId) {
        const existing = [...actionRecords.values()].find(
          (a) => a.organizationId === organizationId && a.findingId === findingId,
        );
        if (existing) return Promise.resolve({ id: existing.id });
        const id = randomUUID();
        actionRecords.set(id, {
          id,
          organizationId,
          projectId,
          findingId,
          state: "DETECTED",
        });
        return Promise.resolve({ id });
      },
    },
    actions: {
      listActions() {
        return Promise.resolve([]);
      },
      getAction() {
        return Promise.resolve(null);
      },
      transitionAction() {
        // Rejects synchronously: every call site awaits inside try/catch, which
        // observes sync throws and rejections identically.
        throw new ActionMutationError("ACTION_NOT_FOUND", "Action not found.");
      },
    },

    patches: {
      create(input) {
        patchRecords.set(input.proposal.id, {
          organizationId: input.organizationId,
          projectId: input.projectId,
          proposal: structuredClone(input.proposal),
          fixtureHtml: input.fixtureHtml,
          eventCount: input.proposal.events.length,
        });
        return Promise.resolve();
      },
      get(organizationId, patchId) {
        const row = patchRecords.get(patchId);
        if (row?.organizationId !== organizationId) return Promise.resolve(null);
        return Promise.resolve({
          proposal: structuredClone(row.proposal),
          fixtureHtml: row.fixtureHtml,
          eventCount: row.eventCount,
        });
      },
      list(organizationId, projectId) {
        return Promise.resolve(
          [...patchRecords.values()]
            .filter((row) => row.organizationId === organizationId && row.projectId === projectId)
            .sort((a, b) => b.proposal.version - a.proposal.version)
            .map((row) => structuredClone(row.proposal)),
        );
      },
      save(input) {
        const row = patchRecords.get(input.patchId);
        if (row?.organizationId !== input.organizationId) return Promise.resolve(false);
        if (
          row.proposal.version !== input.expectedVersion ||
          row.eventCount !== input.previousEventCount
        )
          return Promise.resolve(false);
        row.proposal = structuredClone(input.proposal);
        row.fixtureHtml = input.fixtureHtml;
        row.eventCount = input.proposal.events.length;
        return Promise.resolve(true);
      },
    },
  };
}
