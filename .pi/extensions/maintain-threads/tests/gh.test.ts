import { describe, expect, test } from "bun:test";
import { createGh, runProcess, type Run, type RunOptions } from "../src/gh.ts";

function fixture(responses: Array<string | Error>) {
  const calls: { args: string[]; options: RunOptions }[] = [];
  const run: Run = async (args, options) => {
    calls.push({ args, options });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error("Unexpected request");
    return response;
  };
  return { calls, gh: createGh({ cwd: "/project", run }) };
}

const repository = JSON.stringify({
  nameWithOwner: "owner/repo",
  url: "https://github.com/owner/repo",
});

function response(data: unknown, headers = "") {
  return `HTTP/2.0 200 OK\r\n${headers}\r\n${JSON.stringify(data)}`;
}

describe("gh REST adapter", () => {
  test("resolves the repository once and parses the next page from Link", async () => {
    const { gh, calls } = fixture([
      repository,
      response(
        [{ number: 7 }],
        'Link: <https://api.github.com/repos/owner/repo/issues?page=2>; rel="next"\r\n',
      ),
    ]);
    expect(await gh.repository()).toEqual({ host: "github.com", name: "owner/repo" });
    const result = await gh.request({ method: "GET", path: "/repos/owner/repo/issues?page=1" });
    expect(result).toEqual({ data: [{ number: 7 }], nextPage: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(["repo", "view", "--json", "nameWithOwner,url"]);
    expect(calls[1].args).toContain("--include");
    expect(calls[1].args).toContain("--hostname");
    expect(calls[1].options.cwd).toBe("/project");
  });

  test("sends write bodies as JSON stdin rather than command arguments", async () => {
    const { gh, calls } = fixture([repository, response({ number: 7, state: "open" })]);
    const body = { body: "Quote: ' \"\n$(touch /tmp/not-executed)" };
    await gh.request({ method: "PATCH", path: "/repos/owner/repo/issues/7", body });
    expect(calls[1].args.slice(-2)).toEqual(["--input", "-"]);
    expect(JSON.parse(calls[1].options.input!)).toEqual(body);
    expect(calls[1].args).not.toContain(body.body);
  });

  test("uses the repository host for enterprise REST requests", async () => {
    const { gh, calls } = fixture([
      JSON.stringify({ nameWithOwner: "owner/repo", url: "https://git.example.com/owner/repo" }),
      response([]),
    ]);
    await gh.request({ method: "GET", path: "/repos/owner/repo/issues" });
    expect(calls[1].args).toContain("git.example.com");
  });

  test("rejects malformed responses and unsafe or non-advancing pagination", async () => {
    for (const raw of [
      "not an HTTP response",
      "HTTP/2.0 200 OK\r\n\r\nnot json",
      response([], 'Link: <https://other.example/repos/owner/repo/issues?page=2>; rel="next"\r\n'),
      response([], 'Link: <https://api.github.com/repos/owner/repo/issues?page=1>; rel="next"\r\n'),
    ]) {
      const { gh } = fixture([repository, raw]);
      await expect(
        gh.request({ method: "GET", path: "/repos/owner/repo/issues?page=1" }),
      ).rejects.toThrow();
    }
  });

  test("does not retry failed writes and warns about uncertain completion", async () => {
    const { gh, calls } = fixture([repository, new Error("HTTP 502: unavailable")]);
    await expect(
      gh.request({ method: "POST", path: "/repos/owner/repo/issues", body: { title: "test" } }),
    ).rejects.toThrow("Verify the thread before retrying");
    expect(calls).toHaveLength(2);
  });

  test("repository failures prevent API requests", async () => {
    const { gh, calls } = fixture([new Error("not a git repository")]);
    await expect(gh.request({ method: "GET", path: "/repos/owner/repo/issues" })).rejects.toThrow(
      "repository",
    );
    expect(calls).toHaveLength(1);
  });

  test("pre-aborted requests never invoke gh", async () => {
    const { gh, calls } = fixture([]);
    await expect(gh.repository(AbortSignal.abort())).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("process execution", () => {
  test("passes stdin without a shell and ignores GH_REPO overrides", async () => {
    const original = process.env.GH_REPO;
    process.env.GH_REPO = "unrelated/repo";
    try {
      const result = await runProcess(
        process.execPath,
        [
          "-e",
          'let text = ""; for await (const part of process.stdin) text += part; console.log(JSON.stringify({ text, repo: process.env.GH_REPO ?? null }));',
        ],
        { cwd: process.cwd(), input: '$(echo no)\n"hello"' },
      );
      expect(JSON.parse(result)).toEqual({ text: '$(echo no)\n"hello"', repo: null });
    } finally {
      if (original === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = original;
    }
  });

  test("preserves diagnostics for nonzero exit codes", async () => {
    await expect(
      runProcess(
        process.execPath,
        ["-e", 'console.error("HTTP 403: forbidden"); process.exit(1);'],
        { cwd: process.cwd() },
      ),
    ).rejects.toThrow("HTTP 403: forbidden");
  });

  test("redacts token-shaped credentials from diagnostics", async () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    try {
      await runProcess(
        process.execPath,
        ["-e", `console.error(${JSON.stringify(token)}); process.exit(1);`],
        { cwd: process.cwd() },
      );
      throw new Error("Expected rejection");
    } catch (error) {
      expect(String(error)).toContain("[redacted]");
      expect(String(error)).not.toContain(token);
    }
  });

  test("reports missing executables", async () => {
    await expect(
      runProcess("/nonexistent/maintain-threads-gh", [], { cwd: process.cwd() }),
    ).rejects.toThrow("start");
  });

  test("bounds output without returning a partial result", async () => {
    await expect(
      runProcess(process.execPath, ["-e", 'console.log("x".repeat(4096));'], {
        cwd: process.cwd(),
        maxBytes: 128,
      }),
    ).rejects.toThrow("byte limit");
  });

  test("times out stalled processes", async () => {
    await expect(
      runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd: process.cwd(),
        timeoutMs: 30,
      }),
    ).rejects.toThrow("timed out");
  });

  test("cancels running processes", async () => {
    const controller = new AbortController();
    const pending = runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });
});
