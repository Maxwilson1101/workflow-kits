import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Fetch } from "@workflow-kits/http";
import register from "../index.ts";
import * as client from "../src/client.ts";

const createClient = client.createClient;

const original = process.env.XDG_HOME_CACHE;
const roots: string[] = [];
const mocks: Array<{ mockRestore(): void }> = [];

function stubFetch(fetch: Fetch) {
  mocks.push(spyOn(client, "createClient").mockImplementation(() => createClient({ fetch })));
}
afterEach(async () => {
  for (const mock of mocks.splice(0).reverse()) mock.mockRestore();
  if (original === undefined) delete process.env.XDG_HOME_CACHE;
  else process.env.XDG_HOME_CACHE = original;
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

for (const mode of ["configured", "missing", "empty"]) {
  test(`registers search and fetch; uses cache when XDG_HOME_CACHE is ${mode}`, async () => {
    const root = await mkdtemp(join(os.tmpdir(), "pi-arxiv-entry-"));
    roots.push(root);
    const home = join(root, "home");
    mocks.push(spyOn(os, "homedir").mockReturnValue(home));
    const cache = mode === "configured" ? join(root, "cache") : join(home, ".cache");
    if (mode === "missing") delete process.env.XDG_HOME_CACHE;
    else process.env.XDG_HOME_CACHE = mode === "empty" ? "" : cache;
    stubFetch(async () => new Response("%PDF-1.7\nexample"));
    const tools: Parameters<ExtensionAPI["registerTool"]>[0][] = [];
    register({
      registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.push(tool),
    } as unknown as ExtensionAPI);
    expect(tools.map((tool) => tool.name)).toEqual(["arxiv_search", "arxiv_fetch"]);
    const result = await tools[1]!.execute(
      "test",
      { id: "1706.03762v7" },
      undefined,
      undefined,
      {} as Parameters<(typeof tools)[number]["execute"]>[4],
    );
    expect(result.details).toEqual({ path: join(cache, "arxiv", "1706.03762v7.pdf") });
    expect(result.structuredContent).toEqual({
      path: join(cache, "arxiv", "1706.03762v7.pdf"),
    });
  });
}
