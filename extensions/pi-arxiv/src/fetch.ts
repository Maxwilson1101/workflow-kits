import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Request } from "./client.ts";
import { validateId } from "./search.ts";

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function createFetcher(cacheDir: string, request: Request) {
  const directory = resolve(cacheDir);
  let queue = Promise.resolve();

  async function fetchPaper(input: { id: string }, signal?: AbortSignal) {
    const id = validateId(input.id);
    const path = join(directory, `${id.replaceAll("/", "_")}.pdf`);
    signal?.throwIfAborted();
    await mkdir(directory, { recursive: true });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("arXiv cache must be a real directory.");
    try {
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        if (!(await file.stat()).isFile()) throw new Error("Cached PDF must be a regular file.");
        const header = Buffer.alloc(5);
        await file.read(header, 0, 5, 0);
        if (header.toString() !== "%PDF-") throw new Error("Cached file is not a PDF.");
        return { path };
      } finally {
        await file.close();
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const pdf = await request(`https://arxiv.org/pdf/${id}`, signal);
    if (pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("arXiv did not return a PDF.");
    signal?.throwIfAborted();
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, pdf, { flag: "wx", signal });
      signal?.throwIfAborted();
      await link(temporary, path);
    } finally {
      await unlink(temporary).catch((error) => {
        if (!missing(error)) throw error;
      });
    }
    return { path };
  }

  return (input: { id: string }, signal?: AbortSignal) => {
    const task = queue.then(() => fetchPaper(input, signal));
    queue = task.then(
      () => {},
      () => {},
    );
    return task;
  };
}
