// Builds the current workspace, starts an isolated local API and Next server,
// verifies PostgreSQL readiness, runs the authenticated SSR proof, then stops
// both children. This is fixture infrastructure only; it refuses DATABASE_URL
// to prevent remote DB access.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { hasApiListenMarker, hasNextListenMarker } from "./ssr-proof-readiness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiDirectory = resolve(root, "apps/api");
const webDirectory = resolve(root, "apps/web");
let apiOrigin;
let webOrigin;
const socketDirectory = process.env.PG_SOCKET_DIR ?? "/tmp/winseo-pgsocket";
const databasePort = process.env.PGPORT ?? "55432";
const databaseUser = process.env.PGUSER ?? "wina";
const databaseName = process.env.PGDATABASE ?? "serpvera_dev";

if (process.env.DATABASE_URL) {
  throw new Error("Unset DATABASE_URL; this proof is restricted to the local fixture database.");
}
if (!socketDirectory.startsWith("/tmp/") || databaseName !== "serpvera_dev") {
  throw new Error(
    "This proof is restricted to a disposable /tmp PostgreSQL socket and serpvera_dev.",
  );
}

const fixtureEnv = { ...process.env };
delete fixtureEnv.DATABASE_URL;
Object.assign(fixtureEnv, {
  NODE_ENV: "development",
  STORE_DRIVER: "postgres",
  PG_SOCKET_DIR: socketDirectory,
  PGHOST: socketDirectory,
  PGPORT: databasePort,
  PGUSER: databaseUser,
  PGDATABASE: databaseName,
  AUTH_SECRET: "report-ssr-local-fixture-auth-secret-32bytes-minimum",
  NEXT_TELEMETRY_DISABLED: "1",
});

const children = [];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function getAvailablePorts(count) {
  const reservations = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const reservation = createServer();
      await new Promise((resolveListen, rejectListen) => {
        reservation.once("error", rejectListen);
        reservation.listen(0, "127.0.0.1", resolveListen);
      });
      reservations.push(reservation);
    }
    return reservations.map((reservation) => reservation.address().port);
  } finally {
    await Promise.all(
      reservations.map(
        (reservation) =>
          new Promise((resolveClose, rejectClose) =>
            reservation.close((error) => (error ? rejectClose(error) : resolveClose())),
          ),
      ),
    );
  }
}

function buildWebFromCurrentSources() {
  const result = spawnSync("pnpm", ["build"], {
    cwd: root,
    env: { ...fixtureEnv, NODE_ENV: "production", TURBO_FORCE: "1" },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error || result.status !== 0) {
    throw new Error(
      `Fresh workspace build failed: ${result.error?.message ?? `exit ${result.status}`}\n${output.slice(-4_000)}`,
    );
  }
  assert.match(output, /Tasks:\s+\d+ successful, \d+ total/);
  assert.match(output, /Cached:\s+0 cached, \d+ total/);

  const buildId = readFileSync(resolve(webDirectory, ".next/BUILD_ID"), "utf8").trim();
  const appPaths = JSON.parse(
    readFileSync(resolve(webDirectory, ".next/server/app-paths-manifest.json"), "utf8"),
  );
  const reportRoute = appPaths["/dashboard/[projectId]/reports/page"];
  assert.equal(typeof reportRoute, "string", "the fresh build must include the report route");
  const reportArtifact = resolve(webDirectory, ".next/server", reportRoute);
  assert.ok(existsSync(reportArtifact), "the compiled report route must exist in the fresh build");
  const reportArtifactHash = sha256(readFileSync(reportArtifact));
  return {
    buildId,
    reportArtifact,
    reportArtifactHash,
    marker: `REPORT_SSR_FRESH_BUILD_OK cached=0 build_id_sha256=${sha256(buildId)} report_route_sha256=${reportArtifactHash}`,
  };
}

function launch(label, command, args, cwd, env) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let spawnError = null;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-12_000);
    });
  }
  child.on("error", (error) => {
    spawnError = error;
    output = `${output}\n${error.message}`.slice(-12_000);
  });
  children.push({
    label,
    child,
    get spawnError() {
      return spawnError;
    },
    get output() {
      return output;
    },
  });
  return child;
}

async function waitForReady(child, url, ready, ownedStartup, label) {
  const deadline = Date.now() + 45_000;
  let lastState = "no response";
  while (Date.now() < deadline) {
    const entry = children.find((candidate) => candidate.child === child);
    if (entry?.spawnError) throw new Error(`${label} could not start: ${entry.spawnError.message}`);
    if (child.exitCode !== null) {
      const detail = entry?.output ?? "";
      throw new Error(`${label} exited with code ${child.exitCode}. ${detail.slice(-2_000)}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      const body = await response.json().catch(() => null);
      const entry = children.find((candidate) => candidate.child === child);
      lastState = `${response.status} ${JSON.stringify(body)}; ownedStartup=${ownedStartup(entry?.output ?? "")}`;
      if (ready(response, body) && ownedStartup(entry?.output ?? "")) return body;
    } catch (error) {
      lastState = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    }
    await delay(250);
  }
  throw new Error(`${label} did not become ready: ${lastState}`);
}

async function stopChildren() {
  const running = children.filter(({ child }) => child.exitCode === null && !child.killed);
  for (const { child } of running.reverse()) child.kill("SIGTERM");
  await Promise.all(
    running.map(
      ({ child }) =>
        new Promise((resolveClose) => {
          if (child.exitCode !== null) return resolveClose();
          const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            resolveClose();
          }, 5_000);
          child.once("exit", () => {
            clearTimeout(timeout);
            resolveClose();
          });
        }),
    ),
  );
}

try {
  const freshBuild = buildWebFromCurrentSources();
  process.stdout.write(`${freshBuild.marker}\n`);

  const [apiPort, webPort] = await getAvailablePorts(2);
  apiOrigin = `http://127.0.0.1:${apiPort}`;
  webOrigin = `http://127.0.0.1:${webPort}`;

  const api = launch(
    "api",
    resolve(apiDirectory, "node_modules/.bin/tsx"),
    ["src/server.ts"],
    apiDirectory,
    { ...fixtureEnv, PORT: String(apiPort) },
  );
  const readiness = await waitForReady(
    api,
    `${apiOrigin}/ready`,
    (response) => response.status === 200,
    hasApiListenMarker,
    "PostgreSQL API",
  );
  assert.equal(readiness.checks?.store, "postgres");
  assert.equal(readiness.checks?.database, "ready");
  assert.equal(readiness.checks?.migrationState, "ready");
  assert.equal(readiness.checks?.requiredSchemaChecks, "ready");

  const web = launch(
    "web",
    resolve(webDirectory, "node_modules/.bin/next"),
    ["start", "--hostname", "127.0.0.1", "--port", String(webPort)],
    webDirectory,
    { ...fixtureEnv, NODE_ENV: "production", API_URL: apiOrigin, PORT: String(webPort) },
  );
  await waitForReady(
    web,
    `${webOrigin}/login`,
    (response) => response.status < 500,
    (output) => hasNextListenMarker(output, webPort),
    "Next.js",
  );

  const proof = launch(
    "proof",
    process.execPath,
    [resolve(root, "scripts/report-ssr-proof.mjs")],
    root,
    { ...fixtureEnv, API_ORIGIN: apiOrigin, WEB_ORIGIN: webOrigin },
  );
  const proofExit = await new Promise((resolveExit, rejectExit) => {
    proof.once("error", rejectExit);
    proof.once("exit", (code, signal) =>
      code === 0
        ? resolveExit(0)
        : rejectExit(new Error(`SSR proof exited with ${code ?? signal}`)),
    );
  });
  assert.equal(proofExit, 0);
  const proofOutput = children.find((entry) => entry.child === proof)?.output ?? "";
  const proofLine = proofOutput
    .split("\n")
    .find((line) => line.startsWith("SSR_REPORT_OK store=postgres "));
  assert.ok(proofLine, "the SSR child must attest PostgreSQL-backed report rendering");
  assert.equal(
    readFileSync(resolve(webDirectory, ".next/BUILD_ID"), "utf8").trim(),
    freshBuild.buildId,
    "Next must still serve the build created by this proof run",
  );
  assert.equal(
    sha256(readFileSync(freshBuild.reportArtifact)),
    freshBuild.reportArtifactHash,
    "the compiled report route must remain the freshly built artifact",
  );
  process.stdout.write(`${proofLine}\n`);
  process.stdout.write(
    "REPORT_SSR_POSTGRES_GATE_OK api=postgres database=ready migrations=ready\n",
  );
} finally {
  await stopChildren();
}
