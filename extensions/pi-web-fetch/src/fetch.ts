import {
  cacheKey,
  createCache,
  isFresh,
  PARSER_VERSION,
  type CachedPage,
  type Metadata,
} from "./cache.ts";
import { abortable, isTemporaryError, normalizeUrl, type Request } from "./client.ts";
import { parsePage } from "./parse.ts";

export interface FetchInput {
  url: string;
  refresh?: boolean;
}

export type FetchResult = {
  url: string;
  finalUrl: string;
  title: string;
  content: string;
  path: string;
  validatedAt: string;
  cache: "miss" | "hit" | "revalidated" | "updated" | "stale";
  truncated: boolean;
  warning?: string;
};

interface FetcherOptions {
  now?: () => number;
  parse?: typeof parsePage;
  timeoutMs?: number;
}

function result(page: CachedPage, status: FetchResult["cache"], warning?: string): FetchResult {
  const bytes = Buffer.from(page.content);
  let end = Math.min(bytes.length, 50 * 1024);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return {
    url: page.metadata.url,
    finalUrl: page.metadata.finalUrl,
    title: page.metadata.title,
    content: bytes.subarray(0, end).toString("utf8"),
    path: page.path,
    validatedAt: new Date(page.mtimeMs).toISOString(),
    cache: status,
    truncated: end < bytes.length,
    ...(warning ? { warning } : {}),
  };
}

export function createFetcher(cacheDir: string, request: Request, options: FetcherOptions = {}) {
  const now = options.now ?? Date.now;
  const parse = options.parse ?? parsePage;
  const cache = createCache(cacheDir, now);
  let queue = Promise.resolve();

  return async (input: FetchInput, signal?: AbortSignal): Promise<FetchResult> => {
    const url = normalizeUrl(input.url);
    if (input.refresh !== undefined && typeof input.refresh !== "boolean") {
      throw new Error("refresh must be a boolean.");
    }
    const timeoutMs = options.timeoutMs ?? 30000;
    const deadline = performance.now() + timeoutMs;
    const combined = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    const check = () => {
      combined.throwIfAborted();
      if (performance.now() >= deadline)
        throw new DOMException("Web fetch timed out.", "TimeoutError");
    };

    async function execute() {
      check();
      const cached = await cache.load(url);
      check();
      if (cached && !input.refresh && isFresh(cached.mtimeMs, now())) return result(cached, "hit");
      const headers: Record<string, string> = {};
      if (cached?.metadata.etag) headers["If-None-Match"] = cached.metadata.etag;
      if (cached?.metadata.lastModified)
        headers["If-Modified-Since"] = cached.metadata.lastModified;
      const download = await request(url, headers, combined, cached?.metadata.finalUrl);
      check();
      const etag = download.response.headers.get("ETag") ?? undefined;
      const lastModified = download.response.headers.get("Last-Modified") ?? undefined;
      if (download.response.status === 304) {
        if (
          !cached ||
          download.finalUrl !== cached.metadata.finalUrl ||
          !Object.keys(headers).length
        ) {
          throw new Error("Received HTTP 304 without a matching cached page and validators.");
        }
        const metadata = {
          ...cached.metadata,
          etag: etag ?? cached.metadata.etag,
          lastModified: lastModified ?? cached.metadata.lastModified,
        };
        const saved = await cache.save(metadata, undefined, combined);
        return result({ ...cached, ...saved, metadata }, "revalidated");
      }
      const page = parse(
        download.body,
        download.response.headers.get("Content-Type") ?? "",
        download.finalUrl,
      );
      check();
      const metadata: Metadata = {
        version: PARSER_VERSION,
        url,
        finalUrl: download.finalUrl,
        title: page.title,
        contentHash: cacheKey(page.content),
        etag,
        lastModified,
      };
      const saved = await cache.save(metadata, page.content, combined);
      return result({ ...saved, metadata, content: page.content }, cached ? "updated" : "miss");
    }

    const task = queue.then(execute);
    queue = task.then(
      () => {},
      () => {},
    );
    try {
      return await abortable(task, combined);
    } catch (error) {
      signal?.throwIfAborted();
      if (!isTemporaryError(error)) throw error;
      const cached = await cache.load(url);
      signal?.throwIfAborted();
      if (!cached) throw error;
      return result(
        cached,
        "stale",
        `Refresh failed; returning previously cached content. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}
