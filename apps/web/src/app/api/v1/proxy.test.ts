import assert from "node:assert/strict";
import { it } from "node:test";
import { POST } from "./[...path]/route.ts";

void it("forwards project idempotency keys through the same-origin API proxy", async () => {
  const originalFetch = globalThis.fetch;
  let forwardedUrl = "";
  let forwardedInit: RequestInit | undefined;
  globalThis.fetch = (input, init) => {
    forwardedUrl = input instanceof Request ? input.url : String(input);
    forwardedInit = init;
    return Promise.resolve(Response.json({ ok: true }, { status: 201 }));
  };

  try {
    const key = "d63f2e53-0f23-4bb8-9e83-84d6aad39314";
    const response = await POST(
      new Request("https://serpvera.test/api/v1/projects", {
        method: "POST",
        headers: {
          cookie: "serpvera_session=session-token",
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify({ primaryDomain: "example.test" }),
      }),
      { params: Promise.resolve({ path: ["projects"] }) },
    );

    assert.equal(response.status, 201);
    assert.match(forwardedUrl, /\/v1\/projects$/);
    assert.equal(new Headers(forwardedInit?.headers).get("idempotency-key"), key);
    assert.equal(
      new Headers(forwardedInit?.headers).get("cookie"),
      "serpvera_session=session-token",
    );
    assert.equal(forwardedInit?.body, JSON.stringify({ primaryDomain: "example.test" }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
