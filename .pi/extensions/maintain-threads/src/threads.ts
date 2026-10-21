import { createGh, type Gh, type Repository } from "./gh.ts";

type ThreadState = "open" | "closed";
type ListInput = { state?: ThreadState | "all"; cursor?: string };
type CursorData = { repository: string; state: ThreadState | "all"; page: number };
type Update = { body: string; author: string; createdAt: string };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid GitHub response object.");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid text in GitHub response.");
  return value;
}

function body(value: unknown): string {
  return value === null ? "" : text(value);
}

function issue(value: unknown) {
  const data = object(value);
  if ("pull_request" in data)
    throw new Error("The target is a pull request, not a maintenance thread.");
  if (typeof data.number !== "number" || !Number.isSafeInteger(data.number) || data.number < 1) {
    throw new Error("Invalid thread number in GitHub response.");
  }
  if (data.state !== "open" && data.state !== "closed")
    throw new Error("Invalid thread state in GitHub response.");
  return { number: data.number, title: text(data.title), state: data.state, body: body(data.body) };
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid list in GitHub response.");
  return value;
}

function nextPage(value: number | null, current: number): number | null {
  if (value !== null && (!Number.isSafeInteger(value) || value <= current))
    throw new Error("Invalid pagination in GitHub response.");
  return value;
}

function decodeCursor(cursor: string, repository: string, state: CursorData["state"]): number {
  try {
    if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const data = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      data.repository !== repository ||
      data.state !== state ||
      !Number.isSafeInteger(data.page) ||
      data.page < 2
    )
      throw new Error();
    return data.page;
  } catch {
    throw new Error("Invalid cursor or cursor does not match the current repository and state.");
  }
}

export function createThreads(options: { cwd: string; gh?: Gh; maxResultBytes?: number }) {
  const gh = options.gh ?? createGh({ cwd: options.cwd });
  const maxResultBytes = options.maxResultBytes ?? 50 * 1024;
  function checked<T>(result: T): T {
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > maxResultBytes) {
      throw new Error("Thread result exceeds the byte limit; no partial result was returned.");
    }
    return result;
  }
  async function context(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const repository = await gh.repository(signal);
    return { repository, path: `/repos/${repository.name}/issues` };
  }
  async function requireIssue(path: string, number: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error("Thread number must be a positive integer.");
    const response = await gh.request({ method: "GET", path: `${path}/${number}` }, signal);
    const result = issue(response.data);
    if (result.number !== number) throw new Error("Unexpected thread number in GitHub response.");
    return result;
  }
  function repositoryKey(repository: Repository) {
    return `${repository.host}/${repository.name}`;
  }
  return {
    async list(input: ListInput, signal?: AbortSignal) {
      const { repository, path } = await context(signal);
      const state = input.state ?? "all";
      const key = repositoryKey(repository);
      const page = input.cursor === undefined ? 1 : decodeCursor(input.cursor, key, state);
      const query = new URLSearchParams({
        state,
        sort: "created",
        direction: "desc",
        per_page: "100",
        page: String(page),
      });
      const response = await gh.request({ method: "GET", path: `${path}?${query}` }, signal);
      const threads = array(response.data)
        .filter((value) => !("pull_request" in object(value)))
        .map((value) => {
          const parsed = issue(value);
          const chars = Array.from(parsed.body.replace(/\s+/gu, " ").trim());
          const excerpt = chars.slice(0, 200).join("") + (chars.length > 200 ? "…" : "");
          return { number: parsed.number, title: parsed.title, state: parsed.state, excerpt };
        });
      const next = nextPage(response.nextPage, page);
      const cursor: CursorData | null =
        next === null ? null : { repository: key, state, page: next };
      return checked({
        threads,
        nextCursor:
          cursor === null ? null : Buffer.from(JSON.stringify(cursor)).toString("base64url"),
      });
    },
    async read(number: number, signal?: AbortSignal) {
      const { path } = await context(signal);
      const thread = await requireIssue(path, number, signal);
      const updates: Update[] = [];
      const result = { ...thread, updates };
      checked(result);
      let page: number | null = 1;
      while (page !== null) {
        signal?.throwIfAborted();
        const response = await gh.request(
          { method: "GET", path: `${path}/${number}/comments?per_page=100&page=${page}` },
          signal,
        );
        for (const value of array(response.data)) {
          const data = object(value);
          updates.push({
            body: text(data.body),
            author: data.user == null ? "[unknown]" : text(object(data.user).login),
            createdAt: text(data.created_at),
          });
        }
        checked(result);
        page = nextPage(response.nextPage, page);
      }
      updates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return result;
    },
  };
}
