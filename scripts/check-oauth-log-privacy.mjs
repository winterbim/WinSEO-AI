import { readFileSync } from "node:fs";
import { scanOAuthLogFile } from "./oauth-log-privacy-check.mjs";

try {
  const logPath = process.argv[2] ?? "";
  if (scanOAuthLogFile(logPath)) {
    process.stdout.write("OAUTH_QUERY_LEAK_FOUND\n");
    process.exitCode = 1;
  } else {
    const output = readFileSync(logPath, "utf8");
    const summaries = [...output.matchAll(/(?:^|\n)ℹ tests (\d+)(?:\r?\n|$)/g)];
    const count = summaries.at(-1)?.[1];
    if (!count) {
      process.stderr.write("OAUTH_ROUTE_TEST_COUNT_MISSING\n");
      process.exitCode = 2;
    } else {
      process.stdout.write(`OAUTH_QUERY_LOG_SCAN_OK route_tests=${count}\n`);
    }
  }
} catch {
  process.stderr.write("OAUTH_QUERY_SCAN_ERROR\n");
  process.exitCode = 2;
}
