import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { object, text, type Request } from "./client.ts";

export interface FetchInput {
  title: string;
}

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function createFetcher(cacheDir: string, request: Request) {
  const directory = resolve(cacheDir);
  let queue = Promise.resolve();

  async function fetchPage(input: FetchInput, signal?: AbortSignal) {
    if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 2048) {
      throw new Error("title must contain 1–2048 characters.");
    }
    const title = input.title.trim().replaceAll(" ", "_");
    const name = `${encodeURIComponent(title)}.wikitext`;
    if (Buffer.byteLength(name) > 255) throw new Error("Article filename is too long.");
    const path = join(directory, name);
    signal?.throwIfAborted();
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Wikipedia cache must be a real directory.");
      try {
        const file = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          if (!(await file.stat()).isFile())
            throw new Error("Cached article must be a regular file.");
          return { path };
        } finally {
          await file.close();
        }
      } catch (error) {
        if (!missing(error)) throw error;
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const data = object(await request(`/page/${encodeURIComponent(title)}`, signal));
    if (data.content_model !== "wikitext") throw new Error("Page content must be wikitext.");
    const source = text(data.source, "source");
    signal?.throwIfAborted();
    await mkdir(directory, { recursive: true });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Wikipedia cache must be a real directory.");
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, source, { encoding: "utf8", flag: "wx", signal });
      signal?.throwIfAborted();
      await link(temporary, path);
    } finally {
      await unlink(temporary).catch((error) => {
        if (!missing(error)) throw error;
      });
    }
    return { path };
  }

  return (input: FetchInput, signal?: AbortSignal) => {
    const task = queue.then(() => fetchPage(input, signal));
    queue = task.then(
      () => {},
      () => {},
    );
    return task;
  };
}
