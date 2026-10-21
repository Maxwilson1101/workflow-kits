import { spawn } from "node:child_process";

export type RunOptions = {
  cwd: string;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
};

export type Run = (args: string[], options: RunOptions) => Promise<string>;

export type RestRequest = {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: Record<string, unknown>;
};

export type RestResponse = {
  data: unknown;
  nextPage: number | null;
};

export type Request = (request: RestRequest, signal?: AbortSignal) => Promise<RestResponse>;
export type Repository = { host: string; name: string };
export type Gh = {
  repository(signal?: AbortSignal): Promise<Repository>;
  request: Request;
};

function diagnostic(error: unknown): string {
  let text = error instanceof Error ? error.message : String(error);
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
  ]) {
    const token = process.env[name];
    if (token) text = text.replaceAll(token, "[redacted]");
  }
  return text
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)\b/g, "[redacted]")
    .replace(/(authorization:\s*(?:bearer|token)\s+)\S+/gi, "$1[redacted]");
}

export async function runProcess(
  command: string,
  args: string[],
  options: RunOptions,
): Promise<string> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 30_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const abortError = () =>
    new Error(
      signal.reason?.name === "TimeoutError" ? "gh command timed out." : "gh command cancelled.",
    );
  if (signal.aborted) throw abortError();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GH_PROMPT_DISABLED: "1",
    GH_PAGER: "cat",
    NO_COLOR: "1",
  };
  delete env.GH_REPO;
  delete env.GH_DEBUG;
  delete env.GH_FORCE_TTY;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const abort = () => stop(abortError());
    signal.addEventListener("abort", abort, { once: true });
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      if (failure) return;
      size += chunk.length;
      if (size > (options.maxBytes ?? 8 * 1024 * 1024)) {
        stop(new Error("gh response exceeds the byte limit; no partial result was returned."));
      } else {
        chunks.push(chunk);
      }
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(new Error(`Could not start gh command: ${diagnostic(error)}`));
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stop(new Error(`Could not write gh input: ${diagnostic(error)}`));
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) {
        reject(
          new Error(
            `gh exited with code ${code}: ${diagnostic(Buffer.concat(stderr).toString("utf8").trim())}`,
          ),
        );
      } else resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(options.input);
    if (signal.aborted) abort();
  });
}

function parseResponse(raw: string, repository: Repository, path: string): RestResponse {
  let header = "";
  let body = raw;
  do {
    const boundary = /\r?\n\r?\n/.exec(body);
    if (!boundary || !/^HTTP\/\S+\s+\d{3}\b/.test(body))
      throw new Error("Invalid gh HTTP response.");
    header = body.slice(0, boundary.index);
    body = body.slice(boundary.index + boundary[0].length);
  } while (body.startsWith("HTTP/"));
  const status = Number(/^HTTP\/\S+\s+(\d{3})/.exec(header)![1]);
  if (status < 200 || status >= 300) throw new Error(`GitHub HTTP ${status}.`);
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error("Invalid JSON in gh response.");
  }
  const link = /^link:\s*(.+)$/im.exec(header)?.[1];
  const next = link && /<([^>]+)>;\s*rel="next"/i.exec(link)?.[1];
  if (!next) return { data, nextPage: null };
  const origin =
    repository.host === "github.com" ? "https://api.github.com" : `https://${repository.host}`;
  const prefix = repository.host === "github.com" ? "" : "/api/v3";
  const current = new URL(prefix + path, origin);
  const target = new URL(next);
  const page = Number(target.searchParams.get("page"));
  const currentPage = Number(current.searchParams.get("page") ?? "1");
  if (
    target.origin !== current.origin ||
    target.pathname !== current.pathname ||
    target.username ||
    target.password ||
    !Number.isSafeInteger(page) ||
    page <= currentPage
  )
    throw new Error("Invalid pagination in gh response.");
  return { data, nextPage: page };
}

export function createGh(options: { cwd: string; run?: Run }): Gh {
  const run: Run = options.run ?? ((args, settings) => runProcess("gh", args, settings));
  let resolved: Repository | undefined;
  async function repository(signal?: AbortSignal): Promise<Repository> {
    signal?.throwIfAborted();
    if (resolved) return resolved;
    try {
      const raw = await run(["repo", "view", "--json", "nameWithOwner,url"], {
        cwd: options.cwd,
        signal,
      });
      const data = JSON.parse(raw);
      if (
        typeof data.nameWithOwner !== "string" ||
        !/^[\w.-]+\/[\w.-]+$/.test(data.nameWithOwner)
      ) {
        throw new Error("Invalid repository name.");
      }
      const url = new URL(data.url);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== `/${data.nameWithOwner}`
      ) {
        throw new Error("Invalid repository URL.");
      }
      resolved = { host: url.host, name: data.nameWithOwner };
      return resolved;
    } catch (error) {
      throw new Error(`Could not resolve the current repository: ${diagnostic(error)}`);
    }
  }
  return {
    repository,
    async request(request, signal) {
      signal?.throwIfAborted();
      const repo = await repository(signal);
      if (!request.path.startsWith(`/repos/${repo.name}/issues`))
        throw new Error("Unsupported thread endpoint.");
      const args = [
        "api",
        "--hostname",
        repo.host,
        "--method",
        request.method,
        request.path,
        "--include",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
      ];
      if (request.body !== undefined) args.push("--input", "-");
      try {
        const raw = await run(args, {
          cwd: options.cwd,
          signal,
          input: request.body === undefined ? undefined : JSON.stringify(request.body),
        });
        return parseResponse(raw, repo, request.path);
      } catch (error) {
        const warning =
          request.method === "GET"
            ? ""
            : " The write may have completed. Verify the thread before retrying.";
        throw new Error(`GitHub ${request.method} failed: ${diagnostic(error)}${warning}`);
      }
    },
  };
}
