const allowedDatabases = new Set(["serpvera_dev", "serpvera_test"]);
const allowedHosts = new Set(["127.0.0.1", "localhost"]);

export function isDisposableDatabaseUrl(value) {
  if (typeof value !== "string" || value.length === 0) return false;

  try {
    const url = new URL(value);
    const database = decodeURIComponent(url.pathname.slice(1));
    return (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      allowedHosts.has(url.hostname) &&
      allowedDatabases.has(database)
    );
  } catch {
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!isDisposableDatabaseUrl(process.env.DATABASE_URL)) {
    process.stderr.write("DATABASE_TARGET_BLOCKED\n");
    process.exitCode = 1;
  }
}
