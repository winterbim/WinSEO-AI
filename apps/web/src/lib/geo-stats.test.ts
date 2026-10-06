import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeGeoStats, parseGeoCsv, wilson } from "./geo-stats.ts";

describe("GEO statistics", () => {
  it("parses captures and computes per-engine rates", () => {
    const rows = parseGeoCsv(
      [
        "engine,prompt_id,brand_mentioned,client_cited,citation_domains",
        "ChatGPT,p1,true,true,example.com;source.org",
        "ChatGPT,p2,false,false,source.org",
        "Claude,p1,true,false,docs.example.com",
      ].join("\n"),
    );
    const stats = computeGeoStats(rows);
    assert.equal(stats.inputRows, 3);
    const chatgpt = stats.engines.find((e) => e.engine === "ChatGPT");
    assert.equal(chatgpt?.runs, 2);
    assert.equal(chatgpt?.mentionRate, 0.5);
    assert.equal(chatgpt?.citationRate, 0.5);
    assert.equal(chatgpt?.uniqueCitationDomains, 2);
  });

  it("supports quoted CSV cells", () => {
    const rows = parseGeoCsv(
      'engine,prompt_id,brand_mentioned,client_cited\n"ChatGPT","prompt,1",yes,no',
    );
    assert.equal(rows[0]?.promptId, "prompt,1");
  });

  it("returns a valid Wilson interval", () => {
    const [low, high] = wilson(5, 10);
    assert.ok(low > 0 && low < 0.5);
    assert.ok(high > 0.5 && high < 1);
  });
});
