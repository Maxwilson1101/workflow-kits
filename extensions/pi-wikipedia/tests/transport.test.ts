import { afterEach, expect, test } from "bun:test";
import { createClient } from "../src/client.ts";

const keys = ["https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY"];
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

test("Wikipedia applies proxy settings and preserves safe network diagnostics", async () => {
  process.env.https_proxy = "http://alice:private-secret@127.0.0.1:8000";
  delete process.env.no_proxy;
  delete process.env.NO_PROXY;
  let init: RequestInit | undefined;
  const request = createClient({
    intervalMs: 0,
    fetch: async (_url, options) => {
      init = options;
      throw Object.assign(new Error("private-secret"), { code: "ECONNREFUSED" });
    },
  });
  const error = await request("/page/X").catch((error: Error) => error);
  expect(init).toHaveProperty("dispatcher");
  expect(String(error)).toContain("Route: environment proxy http://127.0.0.1:8000");
  expect(String(error)).toContain("ECONNREFUSED");
  expect(String(error)).not.toContain("private-secret");
});

test("Wikipedia stalled response body honors cancellation and the queue recovers", async () => {
  process.env.no_proxy = "*";
  const reading = Promise.withResolvers<void>();
  const owner = new AbortController();
  const body = new ReadableStream(
    {
      pull() {
        reading.resolve();
      },
    },
    { highWaterMark: 0 },
  );
  let calls = 0;
  const request = createClient({
    intervalMs: 0,
    fetch: async () =>
      ++calls === 1 ? new Response(body) : Response.json({ source: "recovered" }),
  });
  const failed = request("/page/X", owner.signal).catch((error: Error) => error);
  await reading.promise;
  owner.abort();
  expect(String(await failed)).toContain("cancelled");
  expect(await request("/page/Y")).toEqual({ source: "recovered" });
  expect(body.locked).toBe(false);
});
