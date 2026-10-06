// API tests import the server configuration, which requires AUTH_SECRET.
// Keep the fixture key local to the test command and fail closed in production.
if (process.env.NODE_ENV === "production") {
  throw new Error("API test bootstrap must never run in production.");
}

process.env.AUTH_SECRET ??= "winseo-test-only-not-a-secret";
