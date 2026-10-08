import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AI_VISIBILITY_MAX_CSV_BYTES,
  AI_VISIBILITY_MAX_ROWS,
  computeAiVisibilityStats,
  parseAiVisibilityCsv,
  wilsonInterval95,
} from "./ai-visibility.ts";

void describe("AI visibility CSV contract", () => {
  void it("parses captures, optional timestamps, quoted fields, and groups by engine/prompt", () => {
    const rows = parseAiVisibilityCsv(
      [
        "engine,prompt_id,brand_mentioned,client_cited,citation_domains,sampled_at",
        '"ChatGPT","comparison,1",yes,true,Example.com;source.org,2026-10-01T10:30:00+02:00',
        '"ChatGPT","comparison,1",no,false,source.org,',
      ].join("\r\n"),
    );

    assert.equal(rows.length, 2);
    const first = rows.at(0);
    const second = rows.at(1);
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.promptId, "comparison,1");
    assert.deepEqual(first.citationDomains, ["example.com", "source.org"]);
    assert.equal(first.sampledAt, "2026-10-01T08:30:00.000Z");
    assert.equal(second.sampledAt, undefined);
    assert.deepEqual(computeAiVisibilityStats(rows), [
      {
        engine: "ChatGPT",
        promptId: "comparison,1",
        promptsObserved: 1,
        runs: 2,
        mentionCount: 1,
        citationCount: 1,
        mentionRate: 0.5,
        mentionWilson95: [0.09452865480086614, 0.9054713451991339],
        citationRate: 0.5,
        citationWilson95: [0.09452865480086614, 0.9054713451991339],
        uniqueCitationDomains: 2,
        topCitationDomains: [
          ["source.org", 2],
          ["example.com", 1],
        ],
      },
    ]);
  });

  void it("calculates a two-sided 95% Wilson interval from each k/n denominator", () => {
    const [lower, upper] = wilsonInterval95(5, 10);
    assert.ok(Math.abs(lower - 0.23658959361548731) < 1e-12);
    assert.ok(Math.abs(upper - 0.7634104063845126) < 1e-12);
    assert.deepEqual(wilsonInterval95(0, 0), [0, 0]);
    assert.throws(() => wilsonInterval95(11, 10), /integer counts/);
  });

  void it("rejects malformed structure, ambiguous booleans, and invalid domains", () => {
    const header = "engine,prompt_id,brand_mentioned,client_cited,citation_domains";
    assert.throws(
      () => parseAiVisibilityCsv(`${header}\nChatGPT,p1,maybe,no,example.com`),
      /brand_mentioned/,
    );
    assert.throws(
      () => parseAiVisibilityCsv(`${header}\nChatGPT,p1,yes,no,https://example.com`),
      /invalid citation domain/,
    );
    assert.throws(() => parseAiVisibilityCsv(`${header}\nChatGPT,p1,yes,no`), /expected 5 columns/);
    assert.throws(
      () => parseAiVisibilityCsv(`${header}\n"ChatGPT,p1,yes,no,x`),
      /inside a quoted field/,
    );
    assert.throws(
      () => parseAiVisibilityCsv(`${header}\nChatGPT\u0001,p1,yes,no,x`),
      /engine cannot contain control characters/,
    );
  });

  void it("rejects impossible calendar dates, times, and UTC offsets", () => {
    const header = "engine,prompt_id,brand_mentioned,client_cited,sampled_at";
    const row = (sampledAt: string) => `${header}\nChatGPT,p1,true,false,${sampledAt}`;

    assert.equal(
      parseAiVisibilityCsv(row("2024-02-29T23:59:59Z"))[0]?.sampledAt,
      "2024-02-29T23:59:59.000Z",
    );
    for (const sampledAt of [
      "2026-02-29T00:00:00Z",
      "2026-02-31T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-10-07T24:00:00Z",
      "2026-10-07T12:60:00Z",
      "2026-10-07T12:00:00+24:00",
    ]) {
      assert.throws(() => parseAiVisibilityCsv(row(sampledAt)), /valid ISO 8601 timestamp/);
    }
  });

  void it("enforces row and byte limits", () => {
    const header = "engine,prompt_id,brand_mentioned,client_cited,citation_domains";
    const line = "ChatGPT,p1,true,false,example.com";
    assert.throws(
      () =>
        parseAiVisibilityCsv(
          [header, ...Array.from({ length: AI_VISIBILITY_MAX_ROWS + 1 }, () => line)].join("\n"),
        ),
      /5,000/,
    );
    assert.throws(() => parseAiVisibilityCsv("x".repeat(AI_VISIBILITY_MAX_CSV_BYTES + 1)), /1 MiB/);
  });
});
