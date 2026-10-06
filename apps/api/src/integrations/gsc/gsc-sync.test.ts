import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FixtureGscAdapter, GoogleGscAdapter, runGscSync } from "./sync.ts";
import { GscCredentialsRequiredError, type GscMetricRow } from "./types.ts";

const ROW: GscMetricRow = {
  date: "2026-09-30",
  query: "evidence seo",
  page: "https://example.com/evidence",
  country: "fra",
  device: "DESKTOP",
  clicks: 4,
  impressions: 40,
  ctr: 0.1,
  position: 3.5,
};

void describe("GSC scaffold", () => {
  void it("runs a fixture adapter through validation and the persistence port", async () => {
    const persisted: GscMetricRow[] = [];
    const result = await runGscSync(
      new FixtureGscAdapter([ROW]),
      {
        persist(rows) {
          persisted.push(...rows);
          return Promise.resolve();
        },
      },
      "sc-domain:example.com",
      { startDate: "2026-09-01", endDate: "2026-09-30" },
    );
    assert.equal(result.adapterKind, "fixture");
    assert.equal(result.rowCount, 1);
    assert.deepEqual(persisted, [ROW]);
  });

  void it("rejects invalid fixture metrics before persistence", async () => {
    let persisted = false;
    await assert.rejects(
      runGscSync(
        new FixtureGscAdapter([{ ...ROW, ctr: 1.5 }]),
        {
          persist() {
            persisted = true;
            return Promise.resolve();
          },
        },
        "sc-domain:example.com",
        { startDate: "2026-09-01", endDate: "2026-09-30" },
      ),
      /Invalid GSC ctr/,
    );
    assert.equal(persisted, false);
  });

  void it("reports missing live credentials explicitly instead of inventing data", async () => {
    await assert.rejects(
      runGscSync(
        new GoogleGscAdapter(),
        {
          persist() {
            throw new Error("must not persist");
          },
        },
        "sc-domain:example.com",
        { startDate: "2026-09-01", endDate: "2026-09-30" },
      ),
      GscCredentialsRequiredError,
    );
  });
});
