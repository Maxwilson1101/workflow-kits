import { describe, expect, test } from "bun:test";
import { createClient } from "../src/client.ts";

const article = {
  key: "Horn_clause",
  content_model: "wikitext",
  source: "== Definition ==\nA Horn clause.",
};

describe("REST client", () => {
  test("uses English Wikipedia and identifies the client", async () => {
    const request = createClient({
      intervalMs: 0,
      fetch: async (url, init) => {
        expect(String(url)).toBe("https://en.wikipedia.org/w/rest.php/v1/page/Horn_clause");
        expect(new Headers(init?.headers).get("User-Agent")).toContain("pi-wikipedia");
        return Response.json(article);
      },
    });
    expect(await request("/page/Horn_clause")).toEqual(article);
  });
  test("honors retry-after and retries transient responses", async () => {
    let calls = 0;
    const waits: number[] = [];
    const request = createClient({
      intervalMs: 0,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetch: async () =>
        ++calls === 1
          ? new Response("busy", { status: 429, headers: { "Retry-After": "2" } })
          : Response.json(article),
    });
    expect(await request("/page/Horn_clause")).toEqual(article);
    expect(waits).toContain(2000);
    expect(calls).toBe(2);
  });
  test("does not retry permanent HTTP errors", async () => {
    let calls = 0;
    const request = createClient({
      intervalMs: 0,
      fetch: async () => {
        calls++;
        return new Response("missing", { status: 404 });
      },
    });
    await expect(request("/page/Missing")).rejects.toThrow("404");
    expect(calls).toBe(1);
  });
  test("bounds response size", async () => {
    const request = createClient({
      intervalMs: 0,
      maxBytes: 10,
      fetch: async () => Response.json(article),
    });
    await expect(request("/page/Horn_clause")).rejects.toThrow("limit");
  });
  test("follows same-origin API normalization redirects", async () => {
    const urls: string[] = [];
    const request = createClient({
      intervalMs: 0,
      fetch: async (url) => {
        urls.push(url);
        return urls.length === 1
          ? new Response(null, {
              status: 301,
              headers: { Location: "/w/rest.php/v1/page/Horn_clause" },
            })
          : Response.json(article);
      },
    });
    expect(await request("/page/horn_clause")).toEqual(article);
    expect(urls[1]).toBe("https://en.wikipedia.org/w/rest.php/v1/page/Horn_clause");
  });
  test("rejects redirects outside the Wikipedia API", async () => {
    const request = createClient({
      intervalMs: 0,
      fetch: async () =>
        new Response(null, { status: 301, headers: { Location: "https://example.org/source" } }),
    });
    await expect(request("/page/Horn_clause")).rejects.toThrow("Unsafe");
  });
  test("bounds retries", async () => {
    let count = 0;
    const request = createClient({
      intervalMs: 0,
      sleep: async () => {},
      fetch: async () => {
        count++;
        return new Response(null, { status: 503, headers: { "Retry-After": "0" } });
      },
    });
    await expect(request("/page/Horn_clause")).rejects.toThrow("503");
    expect(count).toBe(3);
  });
  for (const status of [429, 503]) {
    for (const header of [undefined, "invalid", "0", "Thu, 01 Jan 1970 00:00:00 GMT"]) {
      test(`reports exhausted HTTP ${status} with Retry-After=${header}`, async () => {
        let calls = 0;
        const request = createClient({
          intervalMs: 0,
          sleep: async () => {},
          fetch: async () => {
            calls++;
            return new Response(null, {
              status,
              headers: header === undefined ? {} : { "Retry-After": header },
            });
          },
        });
        const error = await request("/page/X").catch((error: Error) => error);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(`HTTP ${status}`);
        expect((error as Error).message).toContain("failed after 3 attempts");
        expect((error as Error).message).toContain(
          status === 429 ? "rate limited" : "service unavailable",
        );
        if (status !== 429) expect((error as Error).message).not.toContain("rate limit");
        expect((error as Error).message.includes("Retry-After:")).toBe(
          header === "0" || header === "Thu, 01 Jan 1970 00:00:00 GMT",
        );
        expect(calls).toBe(3);
      });
    }
  }
  test("network failure retains its cause and does not block queued work", async () => {
    const cause = new TypeError("fetch failed: private diagnostic");
    let calls = 0;
    const request = createClient({
      intervalMs: 0,
      fetch: async () => {
        if (++calls === 1) throw cause;
        return Response.json(article);
      },
    });
    const failed = request("/page/X");
    const next = request("/page/Y");
    const error = await failed.catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toBe(cause);
    expect((error as Error).message).toContain("no HTTP response was received");
    expect((error as Error).message).toContain("rate limiting is not confirmed");
    expect((error as Error).message).not.toContain("private diagnostic");
    expect((error as Error).message).not.toContain("HTTP 429");
    expect(await next).toEqual(article);
    expect(calls).toBe(2);
  });
  test("cancelling retry waiting prevents another attempt", async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    let calls = 0;
    const request = createClient({
      intervalMs: 0,
      fetch: async () => {
        calls++;
        return new Response(null, { status: 429 });
      },
      sleep: async (_ms, signal) => {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    const result = request("/page/X", controller.signal);
    const outcome = result.catch((error: Error) => error);
    await entered.promise;
    controller.abort();
    expect(await outcome).toMatchObject({ message: "Wikipedia request was cancelled." });
    expect(calls).toBe(1);
  });
  test("cancelled queued work never accesses the network", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Response>();
    let calls = 0;
    const request = createClient({
      intervalMs: 0,
      fetch: async () => {
        calls++;
        entered.resolve();
        return calls === 1 ? release.promise : Response.json(article);
      },
    });
    const first = request("/page/X");
    await entered.promise;
    const controller = new AbortController();
    const queued = request("/page/Y", controller.signal);
    const outcome = queued.catch((error: Error) => error);
    controller.abort();
    expect(await outcome).toMatchObject({ message: "Wikipedia request was cancelled." });
    release.resolve(Response.json(article));
    await first;
    await request("/page/Z");
    expect(calls).toBe(2);
  });
  test("times out a stalled request", async () => {
    const request = createClient({
      intervalMs: 0,
      timeoutMs: 10,
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    });
    await expect(request("/page/Horn_clause")).rejects.toThrow("Wikipedia request timed out");
  });
  test("pre-aborted requests do not access network", async () => {
    const request = createClient({
      fetch: async () => {
        throw new Error("network accessed");
      },
    });
    await expect(request("/page/X", AbortSignal.abort())).rejects.toThrow("cancelled");
  });
});
