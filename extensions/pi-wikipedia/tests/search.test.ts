import { describe, expect, test } from "bun:test";
import { searchWikipedia } from "../src/search.ts";

describe("search", () => {
  test("returns fetch-compatible titles and relevance information only", async () => {
    const calls: string[] = [];
    const result = await searchWikipedia({ q: "Horn clause" }, async (path) => {
      calls.push(path);
      return {
        pages: [
          {
            id: 1,
            key: "Horn_clause",
            title: "Horn clause",
            description: null,
            excerpt: 'A <span class="searchmatch">Horn</span> clause &amp; more.',
            thumbnail: null,
          },
        ],
      };
    });
    expect(calls).toEqual(["/search/page?q=Horn+clause&limit=5"]);
    expect(result).toEqual({
      pages: [{ title: "Horn_clause", description: null, excerpt: "A Horn clause & more." }],
    });
  });
  test("empty results are successful", async () => {
    expect(await searchWikipedia({ q: "unknown" }, async () => ({ pages: [] }))).toEqual({
      pages: [],
    });
  });
  test("rejects invalid parameters before requesting", async () => {
    const request = async () => {
      throw new Error("should not request");
    };
    await expect(searchWikipedia({ q: " " }, request)).rejects.toThrow("q");
    await expect(searchWikipedia({ q: "x", limit: 101 }, request)).rejects.toThrow("limit");
  });
  test("rejects malformed responses", async () => {
    await expect(searchWikipedia({ q: "x" }, async () => ({ pages: [{}] }))).rejects.toThrow();
  });
});
