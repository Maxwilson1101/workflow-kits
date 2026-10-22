import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici/index.js";
import { resolveRoute, type Route } from "./proxy.ts";

export type Fetch = (
  url: string,
  init?: RequestInit & { dispatcher?: Dispatcher },
) => Promise<Response>;

export interface HttpTransport {
  fetch: Fetch;
  readBody(
    response: Response,
    options: { maxBytes: number; signal: AbortSignal },
  ): Promise<Uint8Array>;
  discard(response: Response): Promise<void>;
}

function networkCode(error: unknown): string | undefined {
  let cause = error;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof cause !== "object" || cause === null) return;
    if (
      "code" in cause &&
      typeof cause.code === "string" &&
      /^[A-Z][A-Z0-9_]{1,60}$/.test(cause.code)
    )
      return cause.code;
    cause = "cause" in cause ? cause.cause : undefined;
  }
}

const tunnelPatterns = [
  /Proxy response \((\d{3})\) !== 200 when HTTP Tunneling/,
  /Proxy refused to open a tunnel: (\d{3})/,
];

function proxyTunnelStatus(error: unknown): number | undefined {
  let cause = error;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof cause !== "object" || cause === null) return;
    const message = "message" in cause ? cause.message : undefined;
    if (typeof message === "string") {
      for (const pattern of tunnelPatterns) {
        const status = pattern.exec(message);
        if (status) return Number(status[1]);
      }
    }
    cause = "cause" in cause ? cause.cause : undefined;
  }
}

function tunnelNote(status: number | undefined) {
  if (status === undefined) return "";
  return status === 407
    ? " Proxy authentication required (HTTP 407); check the proxy credentials."
    : ` Proxy refused the tunnel (HTTP ${status}); the proxy may be unable to reach the destination.`;
}

export class HttpNetworkError extends Error {
  readonly code: string | undefined;
  readonly phase: "request" | "body";
  readonly route: string;
  readonly proxyStatus: number | undefined;

  constructor(label: string, phase: "request" | "body", route: Route, cause: unknown) {
    let code = networkCode(cause);
    const proxyStatus = phase === "request" ? proxyTunnelStatus(cause) : undefined;
    if (proxyStatus !== undefined) code = "ERR_PROXY_TUNNEL";
    if (route.proxy && code) {
      const proxy = new URL(route.proxy);
      const secrets = [
        proxy.username,
        proxy.password,
        decodeURIComponent(proxy.username),
        decodeURIComponent(proxy.password),
      ].filter(Boolean);
      if (secrets.some((secret) => code!.includes(secret))) code = undefined;
    }
    const message =
      phase === "request"
        ? `${label} network request failed; no HTTP response was received.${tunnelNote(proxyStatus)}`
        : `${label} response body could not be downloaded.`;
    super(`${message} ${route.description}${code ? ` Code: ${code}.` : ""}`, { cause });
    this.name = "HttpNetworkError";
    this.code = code;
    this.phase = phase;
    this.route = route.description;
    this.proxyStatus = proxyStatus;
  }
}

function interruptible<T>(
  task: Promise<T>,
  signal: AbortSignal,
  late?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (settled) {
          late?.(value);
          return;
        }
        settled = true;
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

function cancelBody(response: Response) {
  if (!response.body?.locked) void response.body?.cancel().catch(() => {});
}

export async function withHttpTransport<T>(
  options: { fetch?: Fetch; label: string },
  run: (http: HttpTransport) => Promise<T>,
): Promise<T> {
  const fetch: Fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const owner = new AbortController();
  const agents = new Map<string, Agent | ProxyAgent>();
  const responses = new Map<Response, { route: Route; signal: AbortSignal }>();
  const activeReads = new Set<Promise<Uint8Array>>();

  async function discard(response: Response) {
    responses.delete(response);
    cancelBody(response);
  }

  async function read(response: Response, limits: { maxBytes: number; signal: AbortSignal }) {
    const entry = responses.get(response);
    if (!entry)
      throw new Error("Response does not belong to this HTTP transport or was already consumed.");
    const signal = AbortSignal.any([owner.signal, entry.signal, limits.signal]);
    signal.throwIfAborted();
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 0)
      throw new Error("Invalid response byte limit.");
    if (Number(response.headers.get("Content-Length")) > limits.maxBytes) {
      await discard(response);
      throw new Error(`${options.label} response exceeds byte limit.`);
    }
    if (!response.body) throw new Error(`Empty ${options.label} response.`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await interruptible(reader.read(), signal).catch((cause: unknown) => {
          signal.throwIfAborted();
          throw new HttpNetworkError(options.label, "body", entry.route, cause);
        });
        signal.throwIfAborted();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limits.maxBytes)
          throw new Error(`${options.label} response exceeds byte limit.`);
        chunks.push(part.value);
      }
      return Buffer.concat(chunks);
    } finally {
      responses.delete(response);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  const http: HttpTransport = {
    async fetch(raw, init = {}) {
      owner.signal.throwIfAborted();
      const signal = AbortSignal.any([owner.signal, ...(init.signal ? [init.signal] : [])]);
      signal.throwIfAborted();
      const url = new URL(raw);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error("Only HTTP(S) URLs without embedded credentials are supported.");
      if (init.redirect === "follow")
        throw new Error(
          "Automatic redirects are not supported; validate each target and request it explicitly.",
        );
      const route = resolveRoute(url.href);
      const key = route.proxy ?? "";
      let dispatcher = agents.get(key);
      if (!dispatcher) {
        dispatcher = route.proxy ? new ProxyAgent(route.proxy) : new Agent();
        agents.set(key, dispatcher);
      }
      let response: Response;
      try {
        response = await interruptible(
          Promise.resolve().then(() => {
            signal.throwIfAborted();
            return fetch(url.href, {
              ...init,
              redirect: init.redirect ?? "manual",
              signal,
              dispatcher,
            });
          }),
          signal,
          cancelBody,
        );
      } catch (cause) {
        signal.throwIfAborted();
        throw new HttpNetworkError(options.label, "request", route, cause);
      }
      if (signal.aborted) {
        cancelBody(response);
        signal.throwIfAborted();
      }
      responses.set(response, { route, signal });
      return response;
    },
    readBody(response, limits) {
      const task = read(response, limits);
      activeReads.add(task);
      void task.then(
        () => activeReads.delete(task),
        () => activeReads.delete(task),
      );
      return task;
    },
    discard,
  };

  try {
    return await run(http);
  } finally {
    owner.abort();
    await Promise.allSettled(activeReads);
    for (const response of responses.keys()) cancelBody(response);
    responses.clear();
    await Promise.allSettled([...agents.values()].map((agent) => agent.destroy()));
  }
}
