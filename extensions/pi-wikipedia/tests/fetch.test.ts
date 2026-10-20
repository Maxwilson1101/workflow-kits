import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFetcher } from "../src/fetch.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "pi-wikipedia-"));
  roots.push(path);
  return path;
}
const article = {
  key: "Horn_clause",
  content_model: "wikitext",
  source: "== Definition ==\nA Horn clause.",
};

describe("fetch", () => {
  test("saves full source and returns only its absolute path; repeats stay local", async () => {
    const directory = await root();
    let count = 0;
    const fetchPage = createFetcher(directory, async (path) => {
      expect(path).toBe("/page/Horn_clause");
      count++;
      return article;
    });
    const result = await fetchPage({ title: "Horn_clause" });
    expect(result).toEqual({ path: join(directory, "Horn_clause.wikitext") });
    expect(await readFile(result.path, "utf8")).toBe(article.source);
    expect(await fetchPage({ title: "Horn_clause" })).toEqual(result);
    expect(count).toBe(1);
  });
  test("space and underscore titles reuse one cache across instances", async () => {
    const directory = await root();
    const first = await createFetcher(directory, async () => article)({ title: "Horn clause" });
    const second = await createFetcher(directory, async () => {
      throw new Error("network accessed");
    })({ title: "Horn_clause" });
    expect(second).toEqual(first);
    expect(await readFile(first.path, "utf8")).toBe(article.source);
  });
  test("encodes slash titles as one filename and one API segment", async () => {
    const directory = await root();
    const fetchPage = createFetcher(directory, async (path) => {
      expect(path).toBe("/page/AC%2FDC");
      return { ...article, key: "AC/DC" };
    });
    expect((await fetchPage({ title: "AC/DC" })).path).toBe(join(directory, "AC%2FDC.wikitext"));
  });
  test("rejects non-wikitext without publishing files", async () => {
    const directory = await root();
    const fetchPage = createFetcher(directory, async () => ({ ...article, content_model: "json" }));
    await expect(fetchPage({ title: "Horn_clause" })).rejects.toThrow("wikitext");
    expect(await readdir(directory)).toEqual([]);
  });
  test("aborted downloads leave no saved source", async () => {
    const directory = await root();
    const controller = new AbortController();
    const fetchPage = createFetcher(directory, async () => {
      controller.abort();
      return article;
    });
    await expect(fetchPage({ title: "Horn_clause" }, controller.signal)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });
  test("rejects symbolic cache directories", async () => {
    const directory = await root();
    const cacheDir = join(directory, "cache");
    await symlink(await root(), cacheDir);
    await expect(
      createFetcher(cacheDir, async () => article)({ title: "Horn_clause" }),
    ).rejects.toThrow();
  });
});
