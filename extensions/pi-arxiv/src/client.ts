import { setTimeout as delay } from "node:timers/promises";
import { HttpNetworkError, withHttpTransport } from "@workflow-kits/http";

export type Request = (url: string, signal?: AbortSignal) => Promise<Buffer>;
interface ClientOptions {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  maxBytes?: number;
}

export function createClient(options: ClientOptions = {}): Request {
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
    return withHttpTransport({ label: "arXiv", fetch: options.fetch }, async (http) => {
      const response = await http.fetch(url.href, {
        signal,
        redirect: "manual",
        headers: { "User-Agent": "pi-arxiv/0.1.0 (local Pi extension)" },
      });
      if (!response.ok) {
        await http.discard(response);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          throw new Error(
            `arXiv HTTP ${response.status}: redirects are not supported; the request was not followed.`,
          );
        }
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
      const body = await http.readBody(response, { maxBytes, signal });
      return Buffer.from(body);
    }).catch((error: unknown) => {
      if (error instanceof HttpNetworkError && error.phase === "request") {
        throw new Error(error.message, { cause: error.cause });
      }
      throw error;
    });
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
    }).catch((error: unknown) => {
      if (combined.reason?.name === "TimeoutError") {
        throw new DOMException(
          "arXiv request timed out while queued, waiting, or downloading.",
          "TimeoutError",
        );
      }
      throw error;
    });
  };
}
