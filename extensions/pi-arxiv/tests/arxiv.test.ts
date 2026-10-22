import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "../src/client.ts";
import { searchArxiv } from "../src/search.ts";
import { createFetcher } from "../src/fetch.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const feed = (entries = "", total = 0) =>
  `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${total}</opensearch:totalResults>${entries}</feed>`;
const entry = `<entry><id>http://arxiv.org/abs/1706.03762v7</id><title>Attention &amp;\n More</title><summary>A &lt; B</summary><author><name>Alice</name></author><author><name>Bob</name></author><published>2017-06-12T00:00:00Z</published><updated>2023-08-02T00:00:00Z</updated></entry>`;

test("search encodes queries, paginates, and decodes Atom metadata", async () => {
  const result = await searchArxiv(
    { q: 'ti:"attention" AND cat:cs.CL', start: 2, limit: 3 },
    async (url) => {
      const query = new URL(url).searchParams;
      expect(query.get("search_query")).toBe('ti:"attention" AND cat:cs.CL');
      expect(query.get("start")).toBe("2");
      expect(query.get("max_results")).toBe("3");
      return Buffer.from(feed(entry, 10));
    },
  );
  expect(result).toEqual({
    total: 10,
    start: 2,
    papers: [
      {
        id: "1706.03762v7",
        title: "Attention & More",
        summary: "A < B",
        authors: ["Alice", "Bob"],
        published: "2017-06-12T00:00:00Z",
        updated: "2023-08-02T00:00:00Z",
      },
    ],
  });
});

test("search handles empty results and rejects invalid feeds and API error entries", async () => {
  expect((await searchArxiv({ q: "nothing" }, async () => Buffer.from(feed()))).papers).toEqual([]);
  for (const xml of [
    "<html>bad</html>",
    "<feed>",
    feed("<entry><id>http://arxiv.org/api/errors#bad</id><summary>Invalid query</summary></entry>"),
  ]) {
    await expect(searchArxiv({ q: "x" }, async () => Buffer.from(xml))).rejects.toThrow();
  }
});

test("search validates inputs before requesting", async () => {
  for (const input of [{ q: " " }, { q: "x", limit: 0 }, { q: "x", start: -1 }]) {
    await expect(
      searchArxiv(input, async () => {
        throw new Error("unexpected request");
      }),
    ).rejects.toThrow(/q|limit|start/);
  }
});

test("client serializes requests, spaces starts, and survives HTTP failures", async () => {
  let active = 0;
  const waits: number[] = [];
  const request = createClient({
    sleep: async (ms) => {
      waits.push(ms);
    },
    fetch: async () => {
      expect(active++).toBe(0);
      await Promise.resolve();
      active--;
      return new Response("ok");
    },
  });
  await Promise.all([
    request("https://export.arxiv.org/api/query?search_query=x"),
    request("https://arxiv.org/pdf/1706.03762"),
  ]);
  expect(waits[0]).toBeGreaterThan(2900);
  const failed = createClient({ fetch: async () => new Response("busy", { status: 429 }) });
  await expect(failed("https://export.arxiv.org/api/query")).rejects.toThrow("429");
});

test("client bounds bytes, restricts hosts, and supports cancellation", async () => {
  const request = createClient({ maxBytes: 2, fetch: async () => new Response("large") });
  await expect(request("https://arxiv.org/pdf/1706.03762")).rejects.toThrow("limit");
  await expect(request("https://example.com/file")).rejects.toThrow("endpoint");
  await expect(request("https://arxiv.org/pdf/1706.03762", AbortSignal.abort())).rejects.toThrow();
});

test("client honors Retry-After and recovers after HTTP failure", async () => {
  let calls = 0;
  const waits: number[] = [];
  const request = createClient({
    sleep: async (ms) => {
      waits.push(ms);
    },
    fetch: async () =>
      ++calls === 1
        ? new Response(null, { status: 503, headers: { "Retry-After": "7" } })
        : new Response("ok"),
  });
  await expect(request("https://export.arxiv.org/api/query")).rejects.toThrow("Retry-After: 7");
  expect((await request("https://export.arxiv.org/api/query")).toString()).toBe("ok");
  expect(waits[0]).toBeGreaterThan(6900);
});

test("cancelled queued requests reject promptly without reaching the network", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const request = createClient({
    fetch: async () => {
      calls++;
      await gate;
      return new Response("ok");
    },
  });
  const first = request("https://export.arxiv.org/api/query");
  const controller = new AbortController();
  const second = request("https://export.arxiv.org/api/query", controller.signal);
  controller.abort();
  await expect(second).rejects.toThrow();
  release();
  await first;
  await Promise.resolve();
  expect(calls).toBe(1);
});

test("aborted PDF responses publish no file and later fetches recover", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-arxiv-"));
  roots.push(root);
  const controller = new AbortController();
  let calls = 0;
  const fetchPaper = createFetcher(root, async () => {
    if (++calls === 1) controller.abort();
    return Buffer.from("%PDF-1.7\nexample");
  });
  await expect(fetchPaper({ id: "1706.03762" }, controller.signal)).rejects.toThrow();
  expect(await readdir(root)).toEqual([]);
  expect((await fetchPaper({ id: "1706.03762" })).path).toBe(join(root, "1706.03762.pdf"));
});

test("fetch downloads PDFs atomically and reuses modern and legacy IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-arxiv-"));
  roots.push(root);
  let calls = 0;
  const fetchPaper = createFetcher(join(root, "arxiv"), async (url) => {
    expect(url).toMatch(/^https:\/\/arxiv.org\/pdf\//);
    calls++;
    return Buffer.from("%PDF-1.7\nexample");
  });
  for (const id of ["1706.03762v7", "hep-th/9901001v1"]) {
    const result = await fetchPaper({ id });
    expect(result.path).toBe(join(root, "arxiv", `${id.replaceAll("/", "_")}.pdf`));
    expect(await readFile(result.path, "utf8")).toStartWith("%PDF-");
    await fetchPaper({ id });
  }
  expect(calls).toBe(2);
  expect((await readdir(join(root, "arxiv"))).length).toBe(2);
});

test("fetch rejects unsafe IDs, invalid PDFs, and symlink cache entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-arxiv-"));
  roots.push(root);
  const fetchPaper = createFetcher(root, async () => Buffer.from("<html>not a PDF</html>"));
  for (const id of ["../secret", "https://example.com/x", "1706.03762/../../x"]) {
    await expect(fetchPaper({ id })).rejects.toThrow("id");
  }
  await expect(fetchPaper({ id: "1706.03762" })).rejects.toThrow("PDF");
  expect(await readdir(root)).toEqual([]);
  await symlink("/etc/passwd", join(root, "1706.03762.pdf"));
  await expect(fetchPaper({ id: "1706.03762" })).rejects.toThrow();
});
