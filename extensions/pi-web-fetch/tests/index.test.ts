import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Fetch } from "@workflow-kits/http";
import register from "../index.ts";
import * as client from "../src/client.ts";

const createClient = client.createClient;

const original = process.env.XDG_CACHE_HOME;
const roots: string[] = [];
const mocks: Array<{ mockRestore(): void }> = [];

function stubFetch(fetch: Fetch) {
  mocks.push(spyOn(client, "createClient").mockImplementation(() => createClient({ fetch })));
}

afterEach(async () => {
  for (const mock of mocks.splice(0).reverse()) mock.mockRestore();
  if (original === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = original;
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function tools() {
  const result: Parameters<ExtensionAPI["registerTool"]>[0][] = [];
  register({
    registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => result.push(tool),
  } as unknown as ExtensionAPI);
  return result;
}

describe("extension", () => {
  for (const mode of ["configured", "missing", "empty"] as const) {
    test(`registers web_fetch and resolves ${mode} XDG_CACHE_HOME`, async () => {
      const root = await mkdtemp(join(os.tmpdir(), "pi-web-fetch-index-"));
      roots.push(root);
      const home = join(root, "home");
      mocks.push(spyOn(os, "homedir").mockReturnValue(home));
      if (mode === "missing") delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = mode === "empty" ? "" : join(root, "cache");
      stubFetch(async () => new Response("Hello", { headers: { "Content-Type": "text/plain" } }));
      const registered = tools();
      expect(registered).toHaveLength(1);
      const tool = registered[0]!;
      expect(tool.name).toBe("web_fetch");
      expect(tool.description.length).toBeLessThan(200);
      expect(tool.description).toContain("untrusted data");
      const result = await tool.execute(
        "test",
        { url: "https://example.com" },
        undefined,
        undefined,
        {} as Parameters<typeof tool.execute>[4],
      );
      const data = result.structuredContent as { path: string; content: string; cache: string };
      const base = mode === "configured" ? join(root, "cache") : join(home, ".cache");
      expect(data.path.startsWith(join(base, "pi-web-fetch") + "/")).toBe(true);
      expect(data.content).toBe("Hello");
      expect(data.cache).toBe("miss");
      expect(result.details).toEqual(data);
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(data);
    });
  }

  for (const status of [403, 404, 429, 503]) {
    test(`exposes HTTP ${status} and Retry-After at the tool boundary`, async () => {
      const root = await mkdtemp(join(os.tmpdir(), "pi-web-fetch-http-"));
      roots.push(root);
      process.env.XDG_CACHE_HOME = root;
      stubFetch(async () => new Response(null, { status, headers: { "Retry-After": "60" } }));
      const tool = tools()[0]!;
      await expect(
        tool.execute(
          "test",
          { url: "https://example.com" },
          undefined,
          undefined,
          {} as Parameters<typeof tool.execute>[4],
        ),
      ).rejects.toThrow(`HTTP ${status}. Retry-After: 60.`);
    });
  }

  test("exposes network error codes at the tool boundary", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "pi-web-fetch-network-"));
    roots.push(root);
    process.env.XDG_CACHE_HOME = root;
    const cause = Object.assign(new Error("TLS verification failed"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });
    stubFetch(async () => {
      throw new TypeError("fetch failed", { cause });
    });
    const tool = tools()[0]!;
    await expect(
      tool.execute(
        "test",
        { url: "https://example.com" },
        undefined,
        undefined,
        {} as Parameters<typeof tool.execute>[4],
      ),
    ).rejects.toThrow("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
  });

  test("exposes proxy authentication failures without credentials at the tool boundary", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "pi-web-fetch-proxy-"));
    roots.push(root);
    process.env.XDG_CACHE_HOME = root;
    process.env.http_proxy = "http://alice:private-secret@localhost:8000";
    const cause = Object.assign(new Error("Proxy Authentication Required (407)"), {
      code: "UND_ERR_INVALID_ARG",
    });
    stubFetch(async () => {
      throw new TypeError("private-secret", { cause });
    });
    const tool = tools()[0]!;
    const error = await tool
      .execute(
        "test",
        { url: "http://example.test" },
        undefined,
        undefined,
        {} as Parameters<typeof tool.execute>[4],
      )
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("authentication required (HTTP 407)");
    expect(String(error)).toContain("ERR_PROXY_AUTH");
    expect(String(error)).not.toMatch(/alice|private-secret|no HTTP response/);
  });

  test("rejects relative XDG_CACHE_HOME", () => {
    process.env.XDG_CACHE_HOME = "relative/cache";
    expect(tools).toThrow("absolute");
  });
});
