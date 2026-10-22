import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cacheKey, TTL_MS } from "../src/cache.ts";
import { createClient, normalizeUrl } from "../src/client.ts";
import { createFetcher } from "../src/fetch.ts";
import { parsePage } from "../src/parse.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(responses: Array<Response | Error> = []) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-fetch-"));
  roots.push(root);
  let time = Date.parse("2026-07-01T00:00:00Z");
  const fetch = mock(async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("Unexpected network request.");
    return response;
  });
  const request = createClient({ fetch, minIntervalMs: 0 });
  const parse = mock(parsePage);
  const options = { now: () => time, parse };
  const run = createFetcher(root, request, options);
  return {
    root,
    fetch,
    parse,
    request,
    options,
    run,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

function page(text = "First version", headers: Record<string, string> = {}) {
  return new Response(
    `<html><head><title>Example</title></head><body><main><p>${text}</p></main></body></html>`,
    {
      headers: { "Content-Type": "text/html; charset=utf-8", ETag: '"v1"', ...headers },
    },
  );
}

const url = "https://example.com/docs?a=1&b=2";

describe("URL mapping", () => {
  test("drops fragments but preserves query order", () => {
    expect(normalizeUrl(`${url}#section`)).toBe(url);
    expect(cacheKey(normalizeUrl(`${url}#one`))).toBe(cacheKey(normalizeUrl(`${url}#two`)));
    expect(cacheKey(url)).not.toBe(cacheKey("https://example.com/docs?b=2&a=1"));
    expect(cacheKey(url)).toMatch(/^[a-f0-9]{64}$/);
  });

  for (const value of ["file:///etc/passwd", "https://user:secret@example.com", "not a URL"]) {
    test(`rejects unsupported URL ${value}`, () => {
      expect(() => normalizeUrl(value)).toThrow();
    });
  }
});

describe("persistent cache", () => {
  test("caches complete content and reuses it across fetcher instances without parsing", async () => {
    const fixture = await setup([page()]);
    const first = await fixture.run({ url: `${url}#section` });
    expect(first.cache).toBe("miss");
    expect(first.url).toBe(url);
    expect(first.title).toBe("Example");
    expect(first.content).toContain("First version");
    expect(first.path).toBe(join(fixture.root, cacheKey(url), "content.md"));
    expect(await readFile(first.path, "utf8")).toBe(first.content);
    const before = await stat(join(dirname(first.path), "metadata.json"));
    fixture.advance(TTL_MS - 1);
    const other = createFetcher(fixture.root, fixture.request, fixture.options);
    const second = await other({ url });
    expect(second.cache).toBe("hit");
    expect(second.validatedAt).toBe(first.validatedAt);
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(fixture.parse).toHaveBeenCalledTimes(1);
    expect((await stat(join(dirname(first.path), "metadata.json"))).mtimeMs).toBe(before.mtimeMs);
  });

  test("expires at exactly one week and revalidates without rewriting the content", async () => {
    const fixture = await setup([page(), new Response(null, { status: 304 })]);
    const first = await fixture.run({ url });
    const before = await stat(first.path);
    fixture.advance(TTL_MS);
    const second = await fixture.run({ url });
    expect(TTL_MS).toBe(604800000);
    expect(second.cache).toBe("revalidated");
    expect(second.validatedAt).not.toBe(first.validatedAt);
    expect((await stat(first.path)).mtimeMs).toBe(before.mtimeMs);
    expect(fixture.parse).toHaveBeenCalledTimes(1);
    const metadata = JSON.parse(await readFile(join(dirname(first.path), "metadata.json"), "utf8"));
    expect(metadata.url).toBe(url);
    expect(metadata.etag).toBe('"v1"');
  });

  test("refresh bypasses TTL and sends conditional headers", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-fetch-refresh-"));
    roots.push(root);
    const fetch = mock(async (_url: string, init?: RequestInit) => {
      if (fetch.mock.calls.length === 1)
        return page("Old", { "Last-Modified": "Wed, 01 Jul 2026 00:00:00 GMT" });
      expect(new Headers(init?.headers).get("If-None-Match")).toBe('"v1"');
      expect(new Headers(init?.headers).get("If-Modified-Since")).toBe(
        "Wed, 01 Jul 2026 00:00:00 GMT",
      );
      return page("New", { ETag: '"v2"' });
    });
    const run = createFetcher(root, createClient({ fetch, minIntervalMs: 0 }));
    await run({ url });
    const result = await run({ url, refresh: true });
    expect(result.cache).toBe("updated");
    expect(result.content).toContain("New");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("revalidates redirected pages only at their final URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-fetch-redirect-"));
    roots.push(root);
    const fetch = mock(async (target: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (target === url) {
        expect(headers.has("If-None-Match")).toBe(false);
        return new Response(null, { status: 302, headers: { Location: "/final" } });
      }
      if (fetch.mock.calls.length === 2) return page();
      expect(headers.get("If-None-Match")).toBe('"v1"');
      return new Response(null, { status: 304 });
    });
    const parse = mock(parsePage);
    const run = createFetcher(root, createClient({ fetch, minIntervalMs: 0 }), { parse });
    const first = await run({ url });
    expect(first.finalUrl).toBe("https://example.com/final");
    expect((await run({ url, refresh: true })).cache).toBe("revalidated");
    expect(parse).toHaveBeenCalledTimes(1);
  });

  test("redownloads when an expired page has no validators", async () => {
    const fixture = await setup([
      new Response("old", { headers: { "Content-Type": "text/plain" } }),
      new Response("new", { headers: { "Content-Type": "text/plain" } }),
    ]);
    await fixture.run({ url });
    fixture.advance(TTL_MS);
    expect((await fixture.run({ url })).content).toBe("new");
    expect(fixture.parse).toHaveBeenCalledTimes(2);
  });

  test("does not trust cache timestamps in the future", async () => {
    const fixture = await setup([page(), new Response(null, { status: 304 })]);
    const first = await fixture.run({ url });
    const future = new Date(Date.parse(first.validatedAt) + TTL_MS);
    await utimes(join(dirname(first.path), "metadata.json"), future, future);
    expect((await fixture.run({ url })).cache).toBe("revalidated");
  });

  test("serializes concurrent misses into one request", async () => {
    const fixture = await setup([page()]);
    const results = await Promise.all([fixture.run({ url }), fixture.run({ url })]);
    expect(results.map((result) => result.cache)).toEqual(["miss", "hit"]);
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(fixture.parse).toHaveBeenCalledTimes(1);
  });

  for (const failure of [
    new TypeError("offline"),
    new Response(null, { status: 429 }),
    new Response(null, { status: 503 }),
  ]) {
    test(`returns marked stale content on temporary failure ${String(failure)}`, async () => {
      const fixture = await setup([page(), failure]);
      const first = await fixture.run({ url });
      fixture.advance(TTL_MS);
      const result = await fixture.run({ url });
      expect(result.cache).toBe("stale");
      expect(result.warning).toBeTruthy();
      if (failure instanceof Response) expect(result.warning).toContain(`HTTP ${failure.status}`);
      expect(result.validatedAt).toBe(first.validatedAt);
      expect(fixture.parse).toHaveBeenCalledTimes(1);
    });
  }

  test("keeps the client error code in agent-visible stale warnings", async () => {
    const cause = Object.assign(new Error("Connection reset"), { code: "ECONNRESET" });
    const fixture = await setup([page(), new TypeError("fetch failed", { cause })]);
    await fixture.run({ url });
    fixture.advance(TTL_MS);
    const result = await fixture.run({ url });
    expect(result.cache).toBe("stale");
    expect(result.warning).toContain("ECONNRESET");
    expect(JSON.stringify(result)).toContain("ECONNRESET");
  });

  test("returns stale content on timeout without advancing validation time", async () => {
    const fixture = await setup([page(), new Response(new ReadableStream({ start() {} }))]);
    const first = await fixture.run({ url });
    fixture.advance(TTL_MS);
    const run = createFetcher(fixture.root, fixture.request, { ...fixture.options, timeoutMs: 20 });
    const second = await run({ url });
    expect(second.cache).toBe("stale");
    expect(second.validatedAt).toBe(first.validatedAt);
    expect(second.warning).toContain(
      "Web fetch timed out while waiting for or downloading the response.",
    );
  });

  test("rejects an unsolicited 304 instead of publishing an empty cache", async () => {
    const fixture = await setup([new Response(null, { status: 304 })]);
    await expect(fixture.run({ url })).rejects.toThrow("matching cached page");
    expect(await readdir(fixture.root)).toEqual([]);
  });

  for (const status of [403, 404]) {
    test(`does not hide HTTP ${status} behind stale content`, async () => {
      const fixture = await setup([page(), new Response(null, { status })]);
      const first = await fixture.run({ url });
      fixture.advance(TTL_MS);
      await expect(fixture.run({ url })).rejects.toThrow(`HTTP ${status}`);
      const metadata = await stat(join(dirname(first.path), "metadata.json"));
      expect(new Date(metadata.mtimeMs).toISOString()).toBe(first.validatedAt);
    });
  }

  test("a cancelled call does not return stale content or update validation time", async () => {
    const fixture = await setup([page()]);
    const first = await fixture.run({ url });
    fixture.advance(TTL_MS);
    const controller = new AbortController();
    controller.abort();
    await expect(fixture.run({ url }, controller.signal)).rejects.toThrow();
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(
      new Date((await stat(join(dirname(first.path), "metadata.json"))).mtimeMs).toISOString(),
    ).toBe(first.validatedAt);
  });

  for (const filename of ["metadata.json", "content.md"]) {
    test(`recovers from corrupted ${filename}`, async () => {
      const fixture = await setup([page(), page("Recovered")]);
      const first = await fixture.run({ url });
      await writeFile(join(dirname(first.path), filename), "broken");
      const result = await fixture.run({ url });
      expect(result.content).toContain("Recovered");
      expect(fixture.fetch).toHaveBeenCalledTimes(2);
    });
  }

  test("interrupted publication leaves no temporary files and detects mismatched content", async () => {
    const fixture = await setup([page("Old"), page("Interrupted"), page("Recovered")]);
    const first = await fixture.run({ url });
    const original = fs.rename;
    const failure = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).endsWith("metadata.json")) throw new Error("Simulated publication failure.");
      await original(from, to);
    });
    try {
      await expect(fixture.run({ url, refresh: true })).rejects.toThrow("publication failure");
    } finally {
      failure.mockRestore();
    }
    expect((await readdir(dirname(first.path))).sort()).toEqual(["content.md", "metadata.json"]);
    expect((await fixture.run({ url })).content).toContain("Recovered");
    expect(fixture.fetch).toHaveBeenCalledTimes(3);
  });

  test("rejects symlink entry directories", async () => {
    const fixture = await setup([page()]);
    const outside = join(fixture.root, "outside");
    await fs.mkdir(outside);
    await symlink(outside, join(fixture.root, cacheKey(url)));
    await expect(fixture.run({ url })).rejects.toThrow("real directory");
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  test("rejects symlink cache roots", async () => {
    const fixture = await setup([page()]);
    const linked = `${fixture.root}-link`;
    roots.push(linked);
    await symlink(fixture.root, linked);
    const run = createFetcher(linked, fixture.request);
    await expect(run({ url })).rejects.toThrow("real directory");
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  test("rejects symlink entry files without touching their targets", async () => {
    const fixture = await setup([page()]);
    const first = await fixture.run({ url });
    const target = join(fixture.root, "outside.md");
    await writeFile(target, "Do not change");
    await rm(first.path);
    await symlink(target, first.path);
    await expect(fixture.run({ url })).rejects.toThrow("regular file");
    expect(await readFile(target, "utf8")).toBe("Do not change");
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });

  test("truncates tool output without truncating the persistent cache", async () => {
    const text = "你好🌍".repeat(12000);
    const fixture = await setup([
      new Response(text, { headers: { "Content-Type": "text/plain" } }),
    ]);
    const result = await fixture.run({ url });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(50 * 1024);
    expect(result.content).not.toContain("�");
    expect(await readFile(result.path, "utf8")).toBe(text);
    expect((await fixture.run({ url })).truncated).toBe(true);
  });
});
