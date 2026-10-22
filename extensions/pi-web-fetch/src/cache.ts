import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PARSER_VERSION = 1;

export interface Metadata {
  version: number;
  url: string;
  finalUrl: string;
  title: string;
  contentHash: string;
  etag?: string;
  lastModified?: string;
}

export interface CachedPage {
  metadata: Metadata;
  content: string;
  path: string;
  mtimeMs: number;
}

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function cacheKey(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function isFresh(mtimeMs: number, now: number) {
  const age = now - mtimeMs;
  return age >= 0 && age < TTL_MS;
}

async function directory(path: string) {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Web cache must be a real directory.");
    }
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function regularFile(path: string) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Web cache entries must be regular files.");
    }
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function read(path: string, maxBytes: number) {
  if (!(await regularFile(path))) return;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Web cache entries must be regular files.");
    if (stat.size > maxBytes) return;
    return { text: await file.readFile("utf8"), mtimeMs: stat.mtimeMs };
  } finally {
    await file.close();
  }
}

function validMetadata(value: unknown, url: string): value is Metadata {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;
  return (
    data.version === PARSER_VERSION &&
    data.url === url &&
    typeof data.finalUrl === "string" &&
    typeof data.title === "string" &&
    typeof data.contentHash === "string" &&
    /^[a-f0-9]{64}$/.test(data.contentHash) &&
    (data.etag === undefined || typeof data.etag === "string") &&
    (data.lastModified === undefined || typeof data.lastModified === "string")
  );
}

export function createCache(cacheDir: string, now: () => number = Date.now) {
  const root = resolve(cacheDir);
  const entry = (url: string) => join(root, cacheKey(url));

  async function atomicWrite(path: string, content: string, signal?: AbortSignal) {
    await regularFile(path);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx", signal });
      const timestamp = new Date(now());
      await utimes(temporary, timestamp, timestamp);
      signal?.throwIfAborted();
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((error) => {
        if (!missing(error)) throw error;
      });
    }
  }

  async function prepare(url: string) {
    if (!(await directory(root))) await mkdir(root, { recursive: true, mode: 0o700 });
    await directory(root);
    const path = entry(url);
    if (!(await directory(path))) await mkdir(path, { recursive: true, mode: 0o700 });
    await directory(path);
    return path;
  }

  async function load(url: string): Promise<CachedPage | undefined> {
    if (!(await directory(root)) || !(await directory(entry(url)))) return;
    const metadataFile = join(entry(url), "metadata.json");
    const contentFile = join(entry(url), "content.md");
    await regularFile(contentFile);
    const record = await read(metadataFile, 64 * 1024);
    if (!record) return;
    let metadata: unknown;
    try {
      metadata = JSON.parse(record.text);
    } catch {
      return;
    }
    if (!validMetadata(metadata, url)) return;
    const content = await read(contentFile, 64 * 1024 * 1024);
    if (!content || cacheKey(content.text) !== metadata.contentHash) return;
    return { metadata, content: content.text, path: contentFile, mtimeMs: record.mtimeMs };
  }

  async function save(metadata: Metadata, content: string | undefined, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const path = await prepare(metadata.url);
    if (content !== undefined) await atomicWrite(join(path, "content.md"), content, signal);
    await atomicWrite(join(path, "metadata.json"), JSON.stringify(metadata), signal);
    const stat = await lstat(join(path, "metadata.json"));
    return { path: join(path, "content.md"), mtimeMs: stat.mtimeMs };
  }

  return { load, save };
}
