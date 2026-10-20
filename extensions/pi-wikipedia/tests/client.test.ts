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
    await expect(request("/page/Horn_clause")).rejects.toThrow();
  });
  test("pre-aborted requests do not access network", async () => {
    const request = createClient({
      fetch: async () => {
        throw new Error("network accessed");
      },
    });
    await expect(request("/page/X", AbortSignal.abort())).rejects.toThrow();
  });
});
