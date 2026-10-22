import { setTimeout as delay } from "node:timers/promises";

export type Request = (url: string, signal?: AbortSignal) => Promise<Buffer>;
interface ClientOptions {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  maxBytes?: number;
}

export function createClient(options: ClientOptions = {}): Request {
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep =
    options.sleep ??
    (async (ms, signal) => {
      await delay(ms, undefined, { signal });
    });
  let queue = Promise.resolve();
  let nextRequest = 0;

  async function execute(raw: string, signal: AbortSignal) {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !(
        (url.hostname === "export.arxiv.org" && url.pathname === "/api/query") ||
        (url.hostname === "arxiv.org" && /^\/pdf\/[\w./-]+$/.test(url.pathname))
      )
    ) {
      throw new Error("Unsupported arXiv endpoint.");
    }
    signal.throwIfAborted();
    const wait = nextRequest - Date.now();
    if (wait > 0) await sleep(wait, signal);
    signal.throwIfAborted();
    nextRequest = Date.now() + 3000;
    const response = await fetch(url.href, {
      signal,
      redirect: "error",
      headers: { "User-Agent": "pi-arxiv/0.1.0 (local Pi extension)" },
    }).catch((cause: unknown) => {
      signal.throwIfAborted();
      throw new Error("arXiv network request failed; no HTTP response was received.", { cause });
    });
    if (!response.ok) {
      await response.body?.cancel();
      const retry = response.headers.get("Retry-After");
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : NaN;
      const until = retry ? Date.parse(retry) : NaN;
      if (Number.isFinite(seconds))
        nextRequest = Math.max(nextRequest, Date.now() + seconds * 1000);
      else if (Number.isFinite(until)) nextRequest = Math.max(nextRequest, until);
      throw new Error(`arXiv HTTP ${response.status}.${retry ? ` Retry-After: ${retry}.` : ""}`);
    }
    const maxBytes =
      options.maxBytes ?? (url.hostname === "arxiv.org" ? 100 * 1024 * 1024 : 4 * 1024 * 1024);
    if (Number(response.headers.get("Content-Length")) > maxBytes) {
      await response.body?.cancel();
      throw new Error("arXiv response exceeds byte limit.");
    }
    if (!response.body) throw new Error("Empty arXiv response.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxBytes) throw new Error("arXiv response exceeds byte limit.");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }

  return (url, signal) => {
    const combined = AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs ?? 120000),
      ...(signal ? [signal] : []),
    ]);
    const task = queue.then(() => execute(url, combined));
    queue = task.then(
      () => {},
      () => {},
    );
    return new Promise<Buffer>((resolve, reject) => {
      const abort = () => reject(combined.reason);
      combined.addEventListener("abort", abort, { once: true });
      task.then(resolve, reject).finally(() => combined.removeEventListener("abort", abort));
      if (combined.aborted) abort();
    });
  };
}
