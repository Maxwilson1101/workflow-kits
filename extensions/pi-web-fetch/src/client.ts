import { setTimeout as delay } from "node:timers/promises";

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
  constructor(
    public status: number,
    retryAfter: string | null,
  ) {
    super(`Web fetch HTTP ${status}.${retryAfter ? ` Retry-After: ${retryAfter}.` : ""}`);
  }
}

function networkCode(error: unknown) {
  let cause = error;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof cause !== "object" || cause === null) return;
    if ("code" in cause && typeof cause.code === "string") return cause.code;
    cause = "cause" in cause ? cause.cause : undefined;
  }
}

export class NetworkError extends Error {
  readonly code: string | undefined;

  constructor(message: string, cause: unknown) {
    const code = networkCode(cause);
    super(`${message}${code ? ` Code: ${code}.` : ""}`, { cause });
    this.code = code;
  }
}

export function isTemporaryError(error: unknown) {
  return (
    error instanceof NetworkError ||
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

export function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export function createClient(options: ClientOptions = {}): Request {
  const fetch = options.fetch ?? globalThis.fetch;
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
    let url = normalizeUrl(raw);
    for (let redirects = 0; ; redirects++) {
      signal.throwIfAborted();
      const wait = nextRequest - now();
      if (wait > 0) await abortable(sleep(wait, signal), signal);
      signal.throwIfAborted();
      nextRequest = now() + (options.minIntervalMs ?? 1000);
      const response = await abortable(
        fetch(url, {
          signal,
          redirect: "manual",
          credentials: "omit",
          headers: {
            "User-Agent": "pi-web-fetch/0.1.0 (local Pi extension)",
            Accept: "text/html, application/xhtml+xml, text/markdown, text/plain;q=0.9",
            ...(url === validatorUrl ? headers : {}),
          },
        }),
        signal,
      ).catch((cause: unknown) => {
        signal.throwIfAborted();
        throw new NetworkError("Web network request failed; no HTTP response was received.", cause);
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (redirects >= 5) throw new Error("Web fetch exceeded the redirect limit.");
        const location = response.headers.get("Location");
        if (!location) throw new Error("Web redirect has no Location header.");
        url = normalizeUrl(new URL(location, url).href);
        continue;
      }

      if (response.status === 304) {
        await response.body?.cancel();
        return { response, finalUrl: url, body: new Uint8Array() };
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        const retry = response.headers.get("Retry-After");
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : NaN;
        const until = retry ? Date.parse(retry) : NaN;
        if (Number.isFinite(seconds)) nextRequest = Math.max(nextRequest, now() + seconds * 1000);
        else if (Number.isFinite(until)) nextRequest = Math.max(nextRequest, until);
        throw new HttpError(response.status, retry);
      }
      if (Number(response.headers.get("Content-Length")) > maxBytes) {
        await response.body?.cancel();
        throw new Error("Web response exceeds byte limit.");
      }
      if (!response.body) throw new Error("Empty web response.");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const part = await abortable(reader.read(), signal).catch((cause: unknown) => {
            signal.throwIfAborted();
            throw new NetworkError("Web response body could not be downloaded.", cause);
          });
          if (part.done) break;
          size += part.value.byteLength;
          if (size > maxBytes) throw new Error("Web response exceeds byte limit.");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return { response, finalUrl: url, body: Buffer.concat(chunks) };
    }
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
    return abortable(task, combined);
  };
}
