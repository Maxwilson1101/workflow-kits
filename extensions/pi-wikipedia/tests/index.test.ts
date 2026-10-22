import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Fetch } from "@workflow-kits/http";
import register from "../index.ts";
import * as client from "../src/client.ts";

const createClient = client.createClient;

const originalCacheHome = process.env.XDG_CACHE_HOME;
const roots: string[] = [];
const mocks: Array<{ mockRestore(): void }> = [];

function stubFetch(fetch: Fetch) {
  mocks.push(spyOn(client, "createClient").mockImplementation(() => createClient({ fetch })));
}

afterEach(async () => {
  for (const mock of mocks.splice(0).reverse()) mock.mockRestore();
  if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalCacheHome;
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("request failures", () => {
  for (const name of ["wikipedia_search", "wikipedia_fetch"]) {
    test(`${name} preserves safe proxy authentication diagnostics`, async () => {
      const root = await mkdtemp(join(os.tmpdir(), "pi-wikipedia-proxy-"));
      roots.push(root);
      process.env.XDG_CACHE_HOME = root;
      process.env.https_proxy = "http://alice:private-secret@localhost:8000";
      const cause = new Error("Proxy refused to open a tunnel: 407 Rejected");
      stubFetch(async () => {
        throw new TypeError("private-secret", { cause });
      });
      const tools: Parameters<ExtensionAPI["registerTool"]>[0][] = [];
      register({
        registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.push(tool),
      } as unknown as ExtensionAPI);
      const tool = tools.find((tool) => tool.name === name)!;
      const error = await tool
        .execute(
          "test",
          name === "wikipedia_search" ? { q: "Fixture" } : { title: "Fixture" },
          undefined,
          undefined,
          {} as Parameters<typeof tool.execute>[4],
        )
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("authentication required (HTTP 407)");
      expect(String(error)).toContain("ERR_PROXY_AUTH");
      expect(String(error)).not.toMatch(/alice|private-secret|no HTTP response|cause is unknown/);
    });

    test(`${name} preserves actionable network failures`, async () => {
      const root = await mkdtemp(join(os.tmpdir(), "pi-wikipedia-error-"));
      roots.push(root);
      process.env.XDG_CACHE_HOME = root;
      stubFetch(async () => {
        throw new TypeError("fetch failed");
      });
      const tools: Parameters<ExtensionAPI["registerTool"]>[0][] = [];
      register({
        registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.push(tool),
      } as unknown as ExtensionAPI);
      const tool = tools.find((tool) => tool.name === name)!;
      await expect(
        tool.execute(
          "test",
          name === "wikipedia_search" ? { q: "Hajimi" } : { title: "Failure_test" },
          undefined,
          undefined,
          {} as Parameters<typeof tool.execute>[4],
        ),
      ).rejects.toThrow("no HTTP response was received");
    });
  }
});

describe("cache location", () => {
  for (const mode of ["configured", "missing", "empty"] as const) {
    test(`uses the user cache directory when XDG_CACHE_HOME is ${mode}`, async () => {
      const root = await mkdtemp(join(os.tmpdir(), "pi-wikipedia-entry-"));
      roots.push(root);
      const home = join(root, "home");
      mocks.push(spyOn(os, "homedir").mockReturnValue(home));
      const cacheHome = mode === "configured" ? join(root, "cache") : join(home, ".cache");
      if (mode === "missing") delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = mode === "empty" ? "" : cacheHome;
      stubFetch(async () =>
        Response.json({ content_model: "wikitext", source: "A cached article." }),
      );
      const tools: Parameters<ExtensionAPI["registerTool"]>[0][] = [];
      register({
        registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.push(tool),
      } as unknown as ExtensionAPI);
      const tool = tools.find((tool) => tool.name === "wikipedia_fetch");
      expect(tool).toBeDefined();
      const result = await tool!.execute(
        "test",
        { title: "Cache_location_test" },
        undefined,
        undefined,
        {} as Parameters<NonNullable<typeof tool>["execute"]>[4],
      );
      expect(result.details).toEqual({
        path: join(cacheHome, "en.wikipedia.org", "Cache_location_test.wikitext"),
      });
    });
  }
});
