import { setTimeout as delay } from "node:timers/promises";

export type Request = (path: string, signal?: AbortSignal) => Promise<unknown>;
interface ClientOptions {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
}
const base = "https://en.wikipedia.org/w/rest.php/v1";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Wikipedia response.");
  }
  return value as Record<string, unknown>;
}

export function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${name}.`);
  return value;
}

export function createClient(options: ClientOptions = {}): Request {
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep =
    options.sleep ??
    (async (ms, signal) => {
      await delay(ms, undefined, { signal });
    });
  const userAgent =
    process.env.PI_WIKIPEDIA_USER_AGENT ?? "pi-wikipedia/0.1.0 (local Pi extension)";
  const hasContact = /https?:\/\/[^\s)]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(userAgent);
  const interval = options.intervalMs ?? (hasContact ? 1000 : 6500);
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  let queue = Promise.resolve();
  let nextRequest = 0;

  async function execute(path: string, signal: AbortSignal) {
    if (!path.startsWith("/page/") && !path.startsWith("/search/page?")) {
      throw new Error("Unsupported Wikipedia endpoint.");
    }
    let url = new URL(`${base}${path}`);
    let retries = 0;
    let redirects = 0;
    while (true) {
      signal.throwIfAborted();
      const wait = nextRequest - Date.now();
      if (wait > 0) await sleep(wait, signal);
      signal.throwIfAborted();
      nextRequest = Date.now() + interval;
      const response = await fetch(url.href, {
        signal,
        redirect: "manual",
        headers: {
          Accept: "application/json",
          "User-Agent": userAgent,
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("Location");
        if (!location || ++redirects > 5) throw new Error("Invalid Wikipedia redirect.");
        const target = new URL(location, url);
        if (
          target.origin !== url.origin ||
          target.username ||
          target.password ||
          !target.pathname.startsWith("/w/rest.php/v1/page/")
        ) {
          throw new Error("Unsafe Wikipedia redirect.");
        }
        url = target;
        continue;
      }
      if ([429, 502, 503, 504].includes(response.status)) {
        await response.body?.cancel();
        const header = response.headers.get("Retry-After");
        const seconds = header && /^\d+$/.test(header.trim()) ? Number(header) : NaN;
        const parsed = header ? Date.parse(header) : NaN;
        const retryMs = Number.isFinite(seconds)
          ? seconds * 1000
          : Number.isFinite(parsed)
            ? Math.max(0, parsed - Date.now())
            : 5000 * 2 ** retries;
        nextRequest = Math.max(nextRequest, Date.now() + retryMs);
        if (retries++ >= 2) throw new Error(`Wikipedia HTTP ${response.status}.`);
        await sleep(retryMs, signal);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Wikipedia HTTP ${response.status}.`);
      }
      if (Number(response.headers.get("Content-Length")) > maxBytes) {
        await response.body?.cancel();
        throw new Error("Wikipedia response exceeds byte limit.");
      }
      if (!response.body) throw new Error("Empty Wikipedia response.");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > maxBytes) throw new Error("Wikipedia response exceeds byte limit.");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    }
  }

  return async (path, signal) => {
    const combined = AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs ?? 90000),
      ...(signal ? [signal] : []),
    ]);
    combined.throwIfAborted();
    const task = queue.then(() => execute(path, combined));
    queue = task.then(
      () => {},
      () => {},
    );
    return new Promise((resolve, reject) => {
      const abort = () => reject(combined.reason);
      combined.addEventListener("abort", abort, { once: true });
      task.then(resolve, reject).finally(() => combined.removeEventListener("abort", abort));
      if (combined.aborted) abort();
    });
  };
}
