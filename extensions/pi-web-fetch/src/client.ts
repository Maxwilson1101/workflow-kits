import { setTimeout as delay } from "node:timers/promises";
import { HttpNetworkError, withHttpTransport } from "@workflow-kits/http";

export interface Download {
  response: Response;
  finalUrl: string;
  body: Uint8Array;
}

export type Request = (
  url: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  validatorUrl?: string,
) => Promise<Download>;

interface ClientOptions {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  maxBytes?: number;
  minIntervalMs?: number;
}

export class HttpError extends Error {
  public status: number;

  constructor(status: number, retryAfter: string | null) {
    super(`Web fetch HTTP ${status}.${retryAfter ? ` Retry-After: ${retryAfter}.` : ""}`);
    this.status = status;
  }
}

export function isTemporaryError(error: unknown) {
  return (
    error instanceof HttpNetworkError ||
    (error instanceof HttpError && (error.status === 429 || error.status >= 500)) ||
    (error instanceof Error && error.name === "TimeoutError")
  );
}

export function normalizeUrl(raw: string) {
  if (typeof raw !== "string" || raw.length > 8192) throw new Error("Invalid web URL.");
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("URLs containing credentials are not supported.");
  }
  url.hash = "";
  return url.href;
}

export function timeoutFailure() {
  return new DOMException(
    "Web fetch timed out while waiting for or downloading the response.",
    "TimeoutError",
  );
}

export function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

function retryDeadline(retry: string | null, now: number) {
  const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : NaN;
  const until = retry ? Date.parse(retry) : NaN;
  if (Number.isFinite(seconds)) return now + seconds * 1000;
  if (Number.isFinite(until)) return until;
}

export function createClient(options: ClientOptions = {}): Request {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    (async (ms, signal) => {
      await delay(ms, undefined, { signal });
    });
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  let queue = Promise.resolve();
  let nextRequest = 0;

  async function execute(
    raw: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    validatorUrl: string,
  ) {
    return withHttpTransport({ label: "Web", fetch: options.fetch }, async (http) => {
      let url = normalizeUrl(raw);
      for (let redirects = 0; ; redirects++) {
        signal.throwIfAborted();
        const wait = nextRequest - now();
        if (wait > 0) await abortable(sleep(wait, signal), signal);
        signal.throwIfAborted();
        nextRequest = now() + (options.minIntervalMs ?? 1000);
        const response = await http.fetch(url, {
          signal,
          redirect: "manual",
          credentials: "omit",
          headers: {
            "User-Agent": "pi-web-fetch/0.1.0 (local Pi extension)",
            Accept: "text/html, application/xhtml+xml, text/markdown, text/plain;q=0.9",
            ...(url === validatorUrl ? headers : {}),
          },
        });

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await http.discard(response);
          if (redirects >= 5) throw new Error("Web fetch exceeded the redirect limit.");
          const location = response.headers.get("Location");
          if (!location) throw new Error("Web redirect has no Location header.");
          url = normalizeUrl(new URL(location, url).href);
          continue;
        }

        if (response.status === 304) {
          await http.discard(response);
          return { response, finalUrl: url, body: new Uint8Array() };
        }
        if (response.status !== 200) {
          await http.discard(response);
          const retry = response.headers.get("Retry-After");
          const until = retryDeadline(retry, now());
          if (until !== undefined) nextRequest = Math.max(nextRequest, until);
          throw new HttpError(response.status, retry);
        }
        const body = await http.readBody(response, { maxBytes, signal });
        return { response, finalUrl: url, body };
      }
    });
  }

  return (url, headers = {}, signal, validatorUrl = normalizeUrl(url)) => {
    const combined = AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs ?? 30000),
      ...(signal ? [signal] : []),
    ]);
    const task = queue.then(() => execute(url, headers, combined, validatorUrl));
    queue = task.then(
      () => {},
      () => {},
    );
    return abortable(task, combined).catch((error: unknown) => {
      if (combined.reason?.name === "TimeoutError") throw timeoutFailure();
      throw error;
    });
  };
}
