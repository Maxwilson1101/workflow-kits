import { describe, expect, mock, test } from "bun:test";
import { createClient } from "../src/client.ts";

describe("HTTP client", () => {
  test("follows redirects and returns the final URL", async () => {
    const fetch = mock(async (url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return url.endsWith("/old")
        ? new Response(null, { status: 302, headers: { Location: "/new" } })
        : new Response("hello", { headers: { "Content-Type": "text/plain" } });
    });
    const result = await createClient({ fetch, minIntervalMs: 0 })("https://example.com/old");
    expect(result.finalUrl).toBe("https://example.com/new");
    expect(new TextDecoder().decode(result.body)).toBe("hello");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("does not forward validators to a redirected URL", async () => {
    const fetch = mock(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (url.endsWith("/old")) {
        expect(headers.get("If-None-Match")).toBe('"old"');
        return new Response(null, { status: 301, headers: { Location: "/new" } });
      }
      expect(headers.has("If-None-Match")).toBe(false);
      return new Response("new");
    });
    await createClient({ fetch, minIntervalMs: 0 })("https://example.com/old", {
      "If-None-Match": '"old"',
    });
  });

  for (const location of ["file:///etc/passwd", "https://user:password@example.com/"]) {
    test(`rejects redirect target ${location}`, async () => {
      const fetch = mock(
        async () => new Response(null, { status: 302, headers: { Location: location } }),
      );
      await expect(
        createClient({ fetch, minIntervalMs: 0 })("https://example.com"),
      ).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  }

  test("stops after five redirects", async () => {
    const fetch = mock(
      async () => new Response(null, { status: 302, headers: { Location: "/loop" } }),
    );
    await expect(createClient({ fetch, minIntervalMs: 0 })("https://example.com")).rejects.toThrow(
      "redirect",
    );
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  test("enforces the byte limit while streaming even without Content-Length", async () => {
    const fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(4));
              controller.enqueue(new Uint8Array(4));
              controller.close();
            },
          }),
        ),
    );
    await expect(createClient({ fetch, maxBytes: 6 })("https://example.com")).rejects.toThrow(
      "byte limit",
    );
  });

  test("rejects oversized Content-Length without reading the body", async () => {
    const fetch = mock(async () => new Response("large", { headers: { "Content-Length": "100" } }));
    await expect(createClient({ fetch, maxBytes: 6 })("https://example.com")).rejects.toThrow(
      "byte limit",
    );
  });

  test("times out while reading a stalled body", async () => {
    const fetch = mock(async () => new Response(new ReadableStream({ start() {} })));
    await expect(createClient({ fetch, timeoutMs: 20 })("https://example.com")).rejects.toThrow(
      "Web fetch timed out while waiting for or downloading the response.",
    );
  });

  test("timeout includes waiting in the request queue", async () => {
    const fetch = mock(
      async (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const request = createClient({ fetch, timeoutMs: 20, minIntervalMs: 0 });
    const results = await Promise.allSettled([
      request("https://example.com/1"),
      request("https://example.com/2"),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    for (const result of results) {
      expect(result.status === "rejected" && String(result.reason)).toContain(
        "Web fetch timed out while waiting for or downloading the response.",
      );
    }
  });

  test("spaces requests and honors Retry-After without automatic retries", async () => {
    let now = 10000;
    const waits: number[] = [];
    const fetch = mock(async () =>
      fetch.mock.calls.length === 1
        ? new Response(null, { status: 429, headers: { "Retry-After": "5" } })
        : new Response("ok"),
    );
    const request = createClient({
      fetch,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    await expect(request("https://example.com")).rejects.toThrow("HTTP 429");
    expect(fetch).toHaveBeenCalledTimes(1);
    await request("https://example.com");
    await request("https://example.com");
    expect(waits).toEqual([5000, 1000]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test("exposes nested network error codes in the message", async () => {
    const cause = Object.assign(new Error("DNS lookup failed"), { code: "ENOTFOUND" });
    const fetch = mock(async () => {
      throw new TypeError("fetch failed", { cause });
    });
    await expect(createClient({ fetch })("https://example.com")).rejects.toThrow("ENOTFOUND");
  });

  test("preserves direct client error codes", async () => {
    const fetch = mock(async () => {
      throw Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" });
    });
    await expect(createClient({ fetch })("https://example.com")).rejects.toThrow("ECONNREFUSED");
  });

  test("preserves error codes when streaming the response fails", async () => {
    const cause = Object.assign(new Error("Socket reset"), { code: "ECONNRESET" });
    const fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("terminated", { cause }));
            },
          }),
        ),
    );
    await expect(createClient({ fetch })("https://example.com")).rejects.toThrow("ECONNRESET");
  });

  test("reports actionable network errors", async () => {
    const fetch = mock(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(createClient({ fetch })("https://example.com")).rejects.toThrow(
      "no HTTP response was received",
    );
  });
});
