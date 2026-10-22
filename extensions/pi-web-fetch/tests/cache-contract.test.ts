import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TTL_MS } from "../src/cache.ts";
import { createClient } from "../src/client.ts";
import { createFetcher } from "../src/fetch.ts";

const roots: string[] = [];
const keys = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "all_proxy",
  "ALL_PROXY",
  "no_proxy",
  "NO_PROXY",
];
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(async () => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const url = "https://example.test/docs";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pi-web-fetch-contract-"));
  roots.push(root);
  let time = Date.parse("2026-07-01T00:00:00Z");
  let mode: "success" | "failure" = "success";
  const fetch = mock(async () => {
    if (mode === "failure") throw new TypeError("fetch failed");
    return new Response("Fixture", { headers: { "Content-Type": "text/plain" } });
  });
  const run = createFetcher(root, createClient({ fetch, minIntervalMs: 0 }), { now: () => time });
  return {
    fetch,
    run,
    fail: () => {
      mode = "failure";
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("cache contract", () => {
  test("a fresh hit never executes a failing request", async () => {
    const fixture = await setup();
    await fixture.run({ url });
    fixture.fail();
    const hit = await fixture.run({ url });
    expect(hit.cache).toBe("hit");
    expect(hit.warning).toBeUndefined();
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });

  test("refresh bypasses TTL but not stale fallback", async () => {
    const fixture = await setup();
    const seeded = await fixture.run({ url });
    fixture.fail();
    const refreshed = await fixture.run({ url, refresh: true });
    expect(refreshed.cache).toBe("stale");
    expect(refreshed.warning).toBeTruthy();
    expect(refreshed.validatedAt).toBe(seeded.validatedAt);
    expect(refreshed.content).toBe(seeded.content);
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
  });

  test("a failed refresh does not extend the freshness window", async () => {
    const fixture = await setup();
    const seeded = await fixture.run({ url });
    fixture.fail();
    await fixture.run({ url, refresh: true });
    await fixture.run({ url, refresh: true });
    fixture.advance(0);
    expect((await fixture.run({ url })).cache).toBe("hit");
    expect(fixture.fetch).toHaveBeenCalledTimes(3);
    fixture.advance(TTL_MS);
    const expired = await fixture.run({ url });
    expect(expired.cache).toBe("stale");
    expect(expired.validatedAt).toBe(seeded.validatedAt);
    expect(fixture.fetch).toHaveBeenCalledTimes(4);
  });

  test("invalid proxy configuration is never masked by cached content", async () => {
    const fixture = await setup();
    for (const key of keys) delete process.env[key];
    const seeded = await fixture.run({ url });
    process.env.HTTPS_PROXY = "socks5://alice:private-secret@localhost:1080";
    const error = await fixture.run({ url, refresh: true }).catch((error: Error) => error);
    expect(String(error)).toContain("proxy");
    expect(String(error)).not.toContain("private-secret");
    expect((await fixture.run({ url })).cache).toBe("hit");
    expect(seeded.cache).toBe("miss");
  });
});
