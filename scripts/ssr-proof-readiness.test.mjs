import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasApiListenMarker, hasNextListenMarker } from "./ssr-proof-readiness.mjs";

void describe("SSR proof startup ownership", () => {
  void it("requires the API child post-listen marker", () => {
    assert.equal(hasApiListenMarker('{"msg":"API server listening"}'), true);
    assert.equal(hasApiListenMarker("database ready"), false);
  });

  void it("accepts only the Next child announcing the exact selected port", () => {
    assert.equal(hasNextListenMarker("- Local:        http://127.0.0.1:43127\n", 43127), true);
    assert.equal(hasNextListenMarker("- Local:        http://localhost:43127\n", 43127), true);
    assert.equal(hasNextListenMarker("- Local:        http://localhost:43128\n", 43127), false);
    assert.equal(hasNextListenMarker("- Local: http://localhost:431270\n", 43127), false);
  });

  void it("checks startup output after stripping terminal color sequences", () => {
    assert.equal(
      hasNextListenMarker("\u001b[32m- Local: http://localhost:43127\u001b[0m\n", 43127),
      true,
    );
  });
});
