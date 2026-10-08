import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDisposableDatabaseUrl } from "./assert-disposable-db-url.mjs";

void describe("disposable PostgreSQL target guard", () => {
  void it("accepts loopback URLs for the development and test databases", () => {
    assert.equal(isDisposableDatabaseUrl("postgresql://wina@127.0.0.1:55432/serpvera_dev"), true);
    assert.equal(isDisposableDatabaseUrl("postgres://tester@localhost:5432/serpvera_test"), true);
  });

  void it("rejects remote hosts, production database names, and malformed URLs", () => {
    assert.equal(isDisposableDatabaseUrl("postgresql://user@db.example.com/serpvera_dev"), false);
    assert.equal(isDisposableDatabaseUrl("postgresql://user@localhost/customer_prod"), false);
    assert.equal(isDisposableDatabaseUrl("not-a-url"), false);
    assert.equal(isDisposableDatabaseUrl(undefined), false);
  });
});
