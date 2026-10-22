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

test("arXiv applies proxy settings to both API and PDF requests", async () => {
  process.env.https_proxy = "http://alice:private-secret@127.0.0.1:8000";
  delete process.env.no_proxy;
  delete process.env.NO_PROXY;
  const requests: RequestInit[] = [];
  const request = createClient({
    sleep: async () => {},
    fetch: async (_url, init) => {
      requests.push(init!);
      throw Object.assign(new Error("private-secret"), { code: "ECONNREFUSED" });
    },
  });
  for (const url of ["https://export.arxiv.org/api/query", "https://arxiv.org/pdf/1706.03762"]) {
    const error = await request(url).catch((error: Error) => error);
    expect(String(error)).toContain("Route: environment proxy http://127.0.0.1:8000");
    expect(String(error)).toContain("ECONNREFUSED");
    expect(String(error)).not.toContain("private-secret");
  }
  expect(requests).toHaveLength(2);
  expect(requests.every((init) => "dispatcher" in init)).toBe(true);
});

test("arXiv stalled response body honors cancellation and the queue recovers", async () => {
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
    sleep: async () => {},
    fetch: async () => (++calls === 1 ? new Response(body) : new Response("recovered")),
  });
  const failed = request("https://arxiv.org/pdf/1706.03762", owner.signal).catch(
    (error: Error) => error,
  );
  await reading.promise;
  owner.abort();
  expect(await failed).toBe(owner.signal.reason);
  expect((await request("https://arxiv.org/pdf/1706.03762")).toString()).toBe("recovered");
  expect(body.locked).toBe(false);
});
