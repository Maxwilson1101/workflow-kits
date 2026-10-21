import { describe, expect, test } from "bun:test";
import type { Gh, RestRequest, RestResponse } from "../src/gh.ts";
import { createThreads } from "../src/threads.ts";

function fixture(responses: Array<RestResponse | Error>, maxResultBytes?: number) {
  const calls: RestRequest[] = [];
  const gh: Gh = {
    async repository() {
      return { host: "github.com", name: "owner/repo" };
    },
    async request(request, signal) {
      signal?.throwIfAborted();
      calls.push(request);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (!response) throw new Error("Unexpected request");
      return response;
    },
  };
  return { calls, threads: createThreads({ cwd: "/project", gh, maxResultBytes }) };
}

const issue = {
  number: 7,
  title: "A thread",
  state: "open",
  body: "Original body",
  html_url: "https://example.com/7",
};
const page = (data: unknown, nextPage: number | null = null): RestResponse => ({ data, nextPage });
const comment = (body: string, date: string, user: unknown = { login: "afu" }) => ({
  body,
  created_at: date,
  user,
  html_url: "https://example.com/comment",
});

describe("listing threads", () => {
  test("defaults to all states, filters PRs and returns only summary fields", async () => {
    const { threads, calls } = fixture([
      page(
        [
          { ...issue, body: "hello\n  world" },
          { ...issue, number: 8, pull_request: {} },
          { ...issue, number: 9, state: "closed", body: null },
        ],
        2,
      ),
      page([]),
    ]);
    const first = await threads.list({});
    expect(first.threads).toEqual([
      { number: 7, title: "A thread", state: "open", excerpt: "hello world" },
      { number: 9, title: "A thread", state: "closed", excerpt: "" },
    ]);
    expect(first.nextCursor).toBeString();
    const url = new URL(calls[0].path, "https://api.github.com");
    expect(url.searchParams.get("state")).toBe("all");
    expect(url.searchParams.get("sort")).toBe("created");
    expect(url.searchParams.get("direction")).toBe("desc");
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(await threads.list({ cursor: first.nextCursor! })).toEqual({
      threads: [],
      nextCursor: null,
    });
    expect(new URL(calls[1].path, "https://api.github.com").searchParams.get("page")).toBe("2");
  });

  test("an all-PR page still exposes its continuation", async () => {
    const { threads } = fixture([page([{ ...issue, pull_request: {} }], 2)]);
    const result = await threads.list({});
    expect(result.threads).toEqual([]);
    expect(result.nextCursor).toBeString();
  });

  test("makes excerpts without splitting Unicode code points", async () => {
    const { threads } = fixture([page([{ ...issue, body: "😀".repeat(201) }])]);
    const result = await threads.list({});
    expect(result.threads[0].excerpt).toBe("😀".repeat(200) + "…");
  });

  test("rejects malformed and mismatched cursors before REST calls", async () => {
    const { threads, calls } = fixture([page([], 2)]);
    const { nextCursor } = await threads.list({ state: "closed" });
    await expect(threads.list({ state: "open", cursor: nextCursor! })).rejects.toThrow("cursor");
    await expect(threads.list({ cursor: "https://other.example/page=2" })).rejects.toThrow(
      "cursor",
    );
    const foreign = Buffer.from(
      JSON.stringify({ repository: "github.com/other/repo", state: "all", page: 2 }),
    ).toString("base64url");
    await expect(threads.list({ cursor: foreign })).rejects.toThrow("cursor");
    expect(calls).toHaveLength(1);
  });

  test("rejects malformed API data rather than returning an empty list", async () => {
    for (const data of [{ message: "failure" }, [{ ...issue, state: "unexpected" }]]) {
      const { threads } = fixture([page(data)]);
      await expect(threads.list({})).rejects.toThrow("response");
    }
  });
});

describe("reading threads", () => {
  test("reads all comment pages, preserves order and handles missing authors", async () => {
    const { threads, calls } = fixture([
      page(issue),
      page([comment("first", "2026-01-01T00:00:00Z")], 2),
      page([comment("second", "2026-01-02T00:00:00Z", null)]),
    ]);
    expect(await threads.read(7)).toEqual({
      number: 7,
      title: "A thread",
      state: "open",
      body: "Original body",
      updates: [
        { body: "first", author: "afu", createdAt: "2026-01-01T00:00:00Z" },
        { body: "second", author: "[unknown]", createdAt: "2026-01-02T00:00:00Z" },
      ],
    });
    expect(calls).toHaveLength(3);
    expect(calls[2].path).toContain("/issues/7/comments?per_page=100&page=2");
  });

  test("does not return partial success when a later page fails", async () => {
    const { threads } = fixture([page(issue), page([], 2), new Error("HTTP 403")]);
    await expect(threads.read(7)).rejects.toThrow("HTTP 403");
  });

  test("rejects PR targets before fetching comments", async () => {
    const { threads, calls } = fixture([page({ ...issue, pull_request: {} })]);
    await expect(threads.read(7)).rejects.toThrow("pull request");
    expect(calls).toHaveLength(1);
  });

  test("rejects oversized results instead of silently truncating", async () => {
    const { threads } = fixture([page(issue), page([])], 64);
    await expect(threads.read(7)).rejects.toThrow("byte limit");
  });

  test("pre-aborted reads do not make requests", async () => {
    const { threads, calls } = fixture([]);
    await expect(threads.read(7, AbortSignal.abort())).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
