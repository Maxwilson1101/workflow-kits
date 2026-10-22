import { setTimeout as delay } from "node:timers/promises";
import { HttpNetworkError, withHttpTransport } from "@workflow-kits/http";

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
    return withHttpTransport({ label: "Wikipedia", fetch: options.fetch }, async (http) => {
      let url = new URL(`${base}${path}`);
      let retries = 0;
      let redirects = 0;
      while (true) {
        signal.throwIfAborted();
        const wait = nextRequest - Date.now();
        if (wait > 0) await sleep(wait, signal);
        signal.throwIfAborted();
        nextRequest = Date.now() + interval;
        const response = await http.fetch(url.href, {
          signal,
          redirect: "manual",
          headers: {
            Accept: "application/json",
            "User-Agent": userAgent,
          },
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await http.discard(response);
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
          await http.discard(response);
          const header = response.headers.get("Retry-After");
          const seconds = header && /^\d+$/.test(header.trim()) ? Number(header) : NaN;
          const parsed = header ? Date.parse(header) : NaN;
          const retryMs = Number.isFinite(seconds)
            ? seconds * 1000
            : Number.isFinite(parsed)
              ? Math.max(0, parsed - Date.now())
              : 5000 * 2 ** retries;
          nextRequest = Math.max(nextRequest, Date.now() + retryMs);
          if (retries++ >= 2) {
            const reason = response.status === 429 ? "rate limited" : "service unavailable";
            const retry =
              Number.isFinite(seconds) || Number.isFinite(parsed)
                ? ` Retry-After: ${Math.ceil(retryMs / 1000)} seconds.`
                : "";
            throw new Error(
              `Wikipedia HTTP ${response.status}: ${reason}; failed after 3 attempts.${retry}`,
            );
          }
          await sleep(retryMs, signal);
          continue;
        }
        if (!response.ok) {
          await http.discard(response);
          throw new Error(`Wikipedia HTTP ${response.status}.`);
        }
        const body = await http.readBody(response, { maxBytes, signal });
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      }
    });
  }

  return async (path, signal) => {
    const combined = AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs ?? 90000),
      ...(signal ? [signal] : []),
    ]);
    const abortError = () =>
      new Error(
        combined.reason?.name === "TimeoutError"
          ? "Wikipedia request timed out while queued, waiting, or downloading."
          : "Wikipedia request was cancelled.",
        { cause: combined.reason },
      );
    if (combined.aborted) throw abortError();
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
    }).catch((error: unknown) => {
      if (combined.aborted) throw abortError();
      if (
        error instanceof HttpNetworkError &&
        error.phase === "request" &&
        error.proxyStatus === undefined
      ) {
        throw new Error(`${error.message} The cause is unknown; rate limiting is not confirmed.`, {
          cause: error.cause,
        });
      }
      throw error;
    });
  };
}
