// SSR proof for the reports page. Requires a local API and Next server; it
// creates and removes its own organization/project/import in PostgreSQL.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

const web = process.env.WEB_ORIGIN ?? "http://127.0.0.1:3100";
const api = process.env.API_ORIGIN ?? "http://127.0.0.1:3101";
if (process.env.PGDATABASE !== "serpvera_dev" || !process.env.PG_SOCKET_DIR?.startsWith("/tmp/")) {
  throw new Error(
    "This fixture proof requires PGDATABASE=serpvera_dev and a /tmp PostgreSQL socket.",
  );
}
const readinessResponse = await fetch(`${api}/ready`);
const readiness = await readinessResponse.json();
assert.equal(readinessResponse.status, 200, "fixture API must be ready before the SSR proof");
assert.equal(readiness.checks?.store, "postgres", "the SSR proof must use PostgreSQL persistence");
assert.equal(readiness.checks?.database, "ready");
assert.equal(readiness.checks?.migrationState, "ready");
assert.equal(readiness.checks?.requiredSchemaChecks, "ready");
const tag = randomUUID().slice(0, 8);
const email = `report-ssr-${tag}@test.local`;
const slug = `report-ssr-${tag}`;
let cookie = "";

async function request(method, path, body, expectedStatus) {
  const response = await fetch(`${web}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie: `serpvera_session=${cookie}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const session = /serpvera_session=([^;]+)/.exec(
    (response.headers.getSetCookie?.() ?? []).join("; "),
  )?.[1];
  if (session) cookie = session;
  const text = await response.text();
  assert.equal(response.status, expectedStatus, `${method} ${path}: ${text.slice(0, 400)}`);
  return { response, text, body: text ? JSON.parse(text) : null };
}

function cleanup() {
  const env = {
    ...process.env,
    PGHOST: process.env.PG_SOCKET_DIR,
  };
  const args = ["-v", "ON_ERROR_STOP=1", "-d", env.PGDATABASE];
  if (env.PGPORT) args.push("-p", env.PGPORT);
  if (env.PGUSER) args.push("-U", env.PGUSER);
  execFileSync(
    "psql",
    [
      ...args,
      "-c",
      `DELETE FROM organizations WHERE slug = '${slug}'`,
      "-c",
      `DELETE FROM users WHERE email = '${email}'`,
    ],
    { env, stdio: "pipe" },
  );
}

let created = false;
try {
  await request("POST", "/api/v1/auth/register", { email, password: "report-proof-password" }, 201);
  created = true;
  const organization = await request(
    "POST",
    "/api/v1/organizations",
    { name: `Report SSR ${tag}`, slug },
    201,
  );
  const organizationId = organization.body.organization.id;
  await request("POST", "/api/v1/auth/select-organization", { organizationId }, 200);
  const project = await request(
    "POST",
    "/api/v1/projects",
    { organizationId, name: `Report SSR ${tag}`, primaryDomain: "example.com" },
    201,
  );
  const projectId = project.body.project.id;
  const csvText = [
    "engine,prompt_id,brand_mentioned,client_cited,citation_domains,sampled_at",
    "ChatGPT,ssr-report-check,true,true,source.example,2026-10-07T12:00:00Z",
  ].join("\n");
  const csvSha256 = createHash("sha256").update(csvText, "utf8").digest("hex");
  await request(
    "POST",
    `/api/v1/projects/${projectId}/ai-visibility/imports`,
    { csvText, csvSha256 },
    201,
  );
  assert.match(projectId, /^[0-9a-f-]{36}$/i);
  const persistedImportCount = execFileSync(
    "psql",
    [
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-d",
      process.env.PGDATABASE,
      ...(process.env.PGPORT ? ["-p", process.env.PGPORT] : []),
      ...(process.env.PGUSER ? ["-U", process.env.PGUSER] : []),
      "-c",
      `SELECT count(*) FROM ai_visibility_imports WHERE project_id = '${projectId}' AND csv_sha256 = '${csvSha256}'`,
    ],
    {
      env: { ...process.env, PGHOST: process.env.PG_SOCKET_DIR },
      encoding: "utf8",
      stdio: "pipe",
    },
  ).trim();
  assert.equal(persistedImportCount, "1", "the import must exist in PostgreSQL before SSR");

  const report = await fetch(`${web}/dashboard/${projectId}/reports`, {
    headers: { cookie: `serpvera_session=${cookie}` },
  });
  const html = await report.text();
  assert.equal(report.status, 200, html.slice(0, 400));
  const visibleHtml = html.replace(/<!--.*?-->/gs, "");
  for (const expected of [
    "AI visibility",
    "USER_SUPPLIED",
    "DOCUMENTED",
    "Provider verification: not verified",
    "ChatGPT",
    "ssr-report-check",
    "1/1",
    "Expected panel denominator",
    "UNKNOWN",
    csvSha256,
    "No unique connected Search Console property is available",
  ]) {
    assert.ok(visibleHtml.includes(expected), `SSR report is missing ${JSON.stringify(expected)}`);
  }
  assert.ok(!visibleHtml.includes("No persisted AI visibility captures are available"));
  assert.ok(!visibleHtml.includes("GEO score"));
  process.stdout.write(
    `SSR_REPORT_OK store=postgres project=${projectId} persisted_imports=${persistedImportCount} csv_sha256=${csvSha256}\n`,
  );
} finally {
  if (created) cleanup();
}
