import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "../src/client.ts";

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

function environment(values: Record<string, string>) {
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
}

afterEach(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe("shared HTTP transport", () => {
  test("passes the selected proxy and reports its route without credentials", async () => {
    environment({ HTTPS_PROXY: "http://alice:private-secret@localhost:8000" });
    let init: RequestInit | undefined;
    const request = createClient({
      minIntervalMs: 0,
      fetch: async (_url, options) => {
        init = options;
        throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      },
    });
    const error = await request("https://example.test").catch((error: Error) => error);
    expect(init).toHaveProperty("dispatcher");
    expect(String(error)).toContain("Route: environment proxy http://localhost:8000");
    expect(String(error)).toContain("ECONNRESET");
    expect(String(error)).not.toMatch(/alice|private-secret/);
  });

  test("explains direct connections and rejects unsupported proxy protocols", async () => {
    environment({});
    await expect(
      createClient({
        minIntervalMs: 0,
        fetch: async () => {
          throw new Error("offline");
        },
      })("https://example.test"),
    ).rejects.toThrow("Route: direct");
    environment({ HTTPS_PROXY: "socks5://alice:private-secret@localhost:1080" });
    const fetcher = { called: false };
    const error = await createClient({
      minIntervalMs: 0,
      fetch: async () => {
        fetcher.called = true;
        return new Response("unused");
      },
    })("https://example.test").catch((error: Error) => error);
    expect(String(error)).toContain("proxy");
    expect(String(error)).not.toContain("private-secret");
    expect(fetcher.called).toBe(false);
  });
});
