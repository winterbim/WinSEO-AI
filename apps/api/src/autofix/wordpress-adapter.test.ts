import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  WordPressAdapterError,
  WordPressRestAdapter,
  type WordPressFetch,
  type WordPressPatchTarget,
} from "./wordpress-adapter.ts";

function simulator(initial: Record<string, unknown>) {
  const records = new Map<string, Record<string, unknown>>([["/wp-json/wp/v2/media/7", initial]]);
  const calls: {
    url: string;
    method: string;
    authorization: string | undefined;
    body: string | undefined;
  }[] = [];
  const fetcher: WordPressFetch = (input, init) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/subdir/, "");
    calls.push({
      url: input,
      method: init.method,
      authorization: init.headers.authorization,
      body: init.body,
    });
    if (init.method === "OPTIONS") {
      return Promise.resolve(
        response({
          properties: {
            meta: {
              properties: {
                seo_title: { type: "string", context: ["view", "edit"] },
                locked_field: {
                  type: "string",
                  context: ["view"],
                  readonly: true,
                },
              },
            },
          },
        }),
      );
    }
    const current = records.get(path);
    if (!current) return Promise.resolve(response({ code: "rest_not_found" }, false, 404));
    if (init.method === "POST") {
      const update = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      if ("alt_text" in update) current.alt_text = update.alt_text;
      if (update.meta && typeof update.meta === "object") {
        current.meta = {
          ...(current.meta as Record<string, unknown>),
          ...update.meta,
        };
      }
    }
    return Promise.resolve(response(structuredClone(current)));
  };
  return { fetcher, records, calls };
}

function response(value: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: () => Promise.resolve(value) };
}

const credentials = {
  siteUrl: "https://wp.fixture.test/subdir/",
  username: "fixture-user",
  applicationPassword: "fixture-secret",
};
const media: WordPressPatchTarget = { kind: "media", id: 7, field: "alt_text" };

void describe("WordPress REST adapter (simulator only)", () => {
  void it("requires HTTPS and validates resource ids", async () => {
    assert.throws(
      () =>
        new WordPressRestAdapter({
          ...credentials,
          siteUrl: "http://wp.fixture.test",
        }),
      (error: unknown) =>
        error instanceof WordPressAdapterError && error.code === "INVALID_CONFIGURATION",
    );
    const { fetcher } = simulator({ alt_text: "Old alt" });
    const adapter = new WordPressRestAdapter(credentials, fetcher);
    await assert.rejects(
      adapter.read({ kind: "media", id: 0, field: "alt_text" }),
      (error: unknown) => error instanceof WordPressAdapterError && error.code === "INVALID_TARGET",
    );
  });

  void it("reads, writes, replays and verifies a media alt, then verifies rollback", async () => {
    const { fetcher, records, calls } = simulator({ alt_text: "Old alt" });
    let tick = 0;
    const adapter = new WordPressRestAdapter(credentials, fetcher, () => new Date(++tick * 1_000));
    const before = await adapter.read(media);
    const dryRun = await adapter.dryRun(media, before.hash);
    assert.equal(dryRun.writable, true);

    const deployed = await adapter.apply(media, before.hash, "Ceramic dripper");
    assert.equal(deployed.replayed, false);
    assert.equal(
      (records.get("/subdir/wp-json/wp/v2/media/7") ?? records.get("/wp-json/wp/v2/media/7"))
        ?.alt_text,
      "Ceramic dripper",
    );
    const replay = await adapter.apply(media, before.hash, "Ceramic dripper");
    assert.equal(replay.replayed, true);

    const rolledBack = await adapter.rollback(media, deployed.afterHash, before.value);
    assert.equal(rolledBack.replayed, false);
    assert.equal((await adapter.read(media)).hash, before.hash);
    assert.ok(calls.every((call) => call.authorization?.startsWith("Basic ")));
    assert.ok(calls.every((call) => call.url.startsWith("https://wp.fixture.test/subdir/")));
    assert.ok(calls.every((call) => call.url.includes("wp-json/wp/v2/media/7")));
  });

  void it("does not overwrite drift and does not post an unregistered SEO meta key", async () => {
    const { fetcher, records, calls } = simulator({ alt_text: "Old alt" });
    const adapter = new WordPressRestAdapter(credentials, fetcher);
    const before = await adapter.read(media);
    const mediaRecord = records.get("/wp-json/wp/v2/media/7");
    assert.ok(mediaRecord);
    mediaRecord.alt_text = "Human edit";
    await assert.rejects(
      adapter.apply(media, before.hash, "Proposed alt"),
      (error: unknown) => error instanceof WordPressAdapterError && error.code === "SOURCE_CHANGED",
    );

    const seoTarget: WordPressPatchTarget = {
      kind: "post_meta",
      postType: "pages",
      id: 12,
      metaKey: "unregistered_key",
    };
    await assert.rejects(
      adapter.read(seoTarget),
      (error: unknown) =>
        error instanceof WordPressAdapterError && error.code === "CAPABILITY_UNAVAILABLE",
    );
    assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  });

  void it("writes SEO titles only through an explicitly exposed editable string meta field", async () => {
    const { fetcher, calls } = simulator({ alt_text: "Unused" });
    const pagePath = "/subdir/wp-json/wp/v2/pages/12";
    const originalFetch = fetcher;
    const pageFetcher: WordPressFetch = async (url, init) => {
      if (new URL(url).pathname !== pagePath) return originalFetch(url, init);
      calls.push({
        url,
        method: init.method,
        authorization: init.headers.authorization,
        body: init.body,
      });
      if (init.method === "OPTIONS") {
        return response({
          properties: {
            meta: {
              properties: {
                seo_title: { type: "string", context: ["view", "edit"] },
              },
            },
          },
        });
      }
      const page = pageFetcher as unknown as { value: string };
      if (init.method === "POST") {
        const body = JSON.parse(init.body ?? "{}") as {
          meta: { seo_title: string };
        };
        page.value = body.meta.seo_title;
      }
      return response({ meta: { seo_title: page.value } });
    };
    (pageFetcher as unknown as { value: string }).value = "Current SEO title";
    const adapter = new WordPressRestAdapter(credentials, pageFetcher);
    const target: WordPressPatchTarget = {
      kind: "post_meta",
      postType: "pages",
      id: 12,
      metaKey: "seo_title",
    };
    const before = await adapter.read(target);
    const receipt = await adapter.apply(target, before.hash, "New SEO title");
    assert.equal(receipt.afterHash.length, 64);
    assert.deepEqual(JSON.parse(calls.find((call) => call.method === "POST")?.body ?? "{}"), {
      meta: { seo_title: "New SEO title" },
    });
  });
});
