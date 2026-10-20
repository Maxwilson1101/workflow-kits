import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "../index.ts";

const originalCacheHome = process.env.XDG_CACHE_HOME;
const roots: string[] = [];
const mocks: Array<{ mockRestore(): void }> = [];

afterEach(async () => {
  for (const mock of mocks.splice(0).reverse()) mock.mockRestore();
  if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalCacheHome;
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("request failures", () => {
  for (const name of ["wikipedia_search", "wikipedia_fetch"]) {
    test(`${name} preserves actionable network failures`, async () => {
      const root = await mkdtemp(join(os.tmpdir(), "pi-wikipedia-error-"));
      roots.push(root);
      process.env.XDG_CACHE_HOME = root;
      mocks.push(spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed")));
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
      mocks.push(
        spyOn(globalThis, "fetch").mockResolvedValue(
          Response.json({ content_model: "wikitext", source: "A cached article." }),
        ),
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
