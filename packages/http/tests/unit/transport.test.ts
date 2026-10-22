import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { HttpNetworkError, withHttpTransport } from "../../src/index.ts";

const original = process.env.no_proxy;
beforeEach(() => {
  process.env.no_proxy = "*";
});
afterEach(() => {
  if (original === undefined) delete process.env.no_proxy;
  else process.env.no_proxy = original;
});
const signal = () => new AbortController().signal;

test.each([
  [407, /authentication required \(HTTP 407\)/],
  [502, /refused the tunnel \(HTTP 502\)/],
] as const)("reports proxy tunnel status %s without credentials", async (status, expected) => {
  delete process.env.no_proxy;
  process.env.https_proxy = "http://alice:private-secret@localhost:8000";
  const cause = Object.assign(new Error(`Proxy refused to open a tunnel: ${status} Rejected`), {
    code: "ERR_PROXY_TUNNEL",
  });
  const error = await withHttpTransport(
    {
      label: "Fixture",
      fetch: async () => {
        throw new TypeError("fetch failed", { cause });
      },
    },
    (http) => http.fetch("https://example.test"),
  ).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(HttpNetworkError);
  expect((error as HttpNetworkError).proxyStatus).toBe(status);
  expect((error as HttpNetworkError).message).toMatch(expected);
  expect((error as HttpNetworkError).code).toBe(
    status === 407 ? "ERR_PROXY_AUTH" : "ERR_PROXY_TUNNEL",
  );
  expect((error as HttpNetworkError).message).not.toMatch(/alice|private-secret|no HTTP response/);
});

test("leaves non-tunnel request failures without a proxy status note", async () => {
  const error = await withHttpTransport(
    {
      label: "Fixture",
      fetch: async () => {
        throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      },
    },
    (http) => http.fetch("https://example.test"),
  ).catch((error: unknown) => error);
  expect((error as HttpNetworkError).proxyStatus).toBeUndefined();
  expect((error as HttpNetworkError).message).not.toContain("Proxy ");
});

test("passes headers and an owned dispatcher to injected fetch", async () => {
  const fetch = mock(async () => new Response("fixture"));
  await withHttpTransport({ label: "Fixture", fetch }, async (http) => {
    const response = await http.fetch("https://example.test", {
      signal: signal(),
      redirect: "manual",
      headers: { Accept: "text/plain" },
    });
    expect(
      new TextDecoder().decode(await http.readBody(response, { maxBytes: 7, signal: signal() })),
    ).toBe("fixture");
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  const init = (
    fetch.mock.calls as unknown as [string, RequestInit & { dispatcher: { destroyed: boolean } }][]
  )[0]![1];
  expect(new Headers(init.headers).get("Accept")).toBe("text/plain");
  expect(init.redirect).toBe("manual");
  expect(init.dispatcher.destroyed).toBe(true);
});

test("does not call fetch for pre-cancellation or automatic redirects", async () => {
  const fetch = mock(async () => new Response("unused"));
  await expect(
    withHttpTransport({ label: "Fixture", fetch }, (http) =>
      http.fetch("https://example.test", { signal: AbortSignal.abort() }),
    ),
  ).rejects.toThrow();
  await expect(
    withHttpTransport({ label: "Fixture", fetch }, (http) =>
      http.fetch("https://example.test", { redirect: "follow" }),
    ),
  ).rejects.toThrow("redirect");
  expect(fetch).not.toHaveBeenCalled();
});

test("classifies request failure without copying private error text", async () => {
  const cause = Object.assign(new Error("private-token"), { code: "ENOTFOUND" });
  const error = await withHttpTransport(
    {
      label: "Wikipedia",
      fetch: async () => {
        throw new TypeError("private-token", { cause });
      },
    },
    (http) => http.fetch("https://example.test"),
  ).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(HttpNetworkError);
  expect(error).toMatchObject({ phase: "request", code: "ENOTFOUND" });
  expect(String(error)).toContain("no HTTP response was received");
  expect(String(error)).toContain("Route: direct");
  expect(String(error)).not.toContain("private-token");
});

test.each(["cancel", "timeout"])("interrupts a fetch ignoring its signal: %s", async (kind) => {
  const started = Promise.withResolvers<void>();
  const owner = new AbortController();
  const pending = withHttpTransport(
    {
      label: "Fixture",
      fetch: async () => {
        started.resolve();
        return new Promise<Response>(() => {});
      },
    },
    (http) => http.fetch("https://example.test", { signal: owner.signal }),
  );
  const outcome = pending.catch((error: unknown) => error);
  await started.promise;
  owner.abort(new DOMException(kind, kind === "timeout" ? "TimeoutError" : "AbortError"));
  expect(await outcome).toBe(owner.signal.reason);
});

test("cancels a response arriving after owner cancellation", async () => {
  const started = Promise.withResolvers<void>();
  const late = Promise.withResolvers<Response>();
  const cancelled = Promise.withResolvers<void>();
  const owner = new AbortController();
  const pending = withHttpTransport(
    {
      label: "Fixture",
      fetch: async () => {
        started.resolve();
        return late.promise;
      },
    },
    (http) => http.fetch("https://example.test", { signal: owner.signal }),
  );
  const outcome = pending.catch((error: unknown) => error);
  await started.promise;
  owner.abort();
  await outcome;
  late.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled.resolve();
        },
      }),
    ),
  );
  await cancelled.promise;
});

test.each(["cancel", "timeout"])(
  "releases a stalled reader even if cancel never settles: %s",
  async (kind) => {
    const reading = Promise.withResolvers<void>();
    const owner = new AbortController();
    const cancel = mock(() => new Promise<void>(() => {}));
    const body = new ReadableStream(
      {
        pull() {
          reading.resolve();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const pending = withHttpTransport(
      { label: "Fixture", fetch: async () => new Response(body) },
      async (http) => {
        const response = await http.fetch("https://example.test", { signal: owner.signal });
        return http.readBody(response, { maxBytes: 10, signal: owner.signal });
      },
    );
    const outcome = pending.catch((error: unknown) => error);
    await reading.promise;
    owner.abort(new DOMException(kind, kind === "timeout" ? "TimeoutError" : "AbortError"));
    expect(await outcome).toBe(owner.signal.reason);
    expect(body.locked).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
  },
);

test("reports body failure separately and releases its reader", async () => {
  const body = new ReadableStream(
    {
      pull(controller) {
        controller.error(new Error("private diagnostic"));
      },
    },
    { highWaterMark: 0 },
  );
  const error = await withHttpTransport(
    { label: "Fixture", fetch: async () => new Response(body) },
    async (http) => {
      const response = await http.fetch("https://example.test");
      return http.readBody(response, { maxBytes: 10, signal: signal() });
    },
  ).catch((error: unknown) => error);
  expect(error).toMatchObject({ phase: "body" });
  expect(String(error)).toContain("response body");
  expect(String(error)).not.toContain("private diagnostic");
  expect(body.locked).toBe(false);
});

test.each([3, 4])("enforces streamed byte limit at %s bytes", async (length) => {
  const pending = withHttpTransport(
    { label: "Fixture", fetch: async () => new Response("x".repeat(length)) },
    async (http) => {
      const response = await http.fetch("https://example.test");
      return http.readBody(response, { maxBytes: 3, signal: signal() });
    },
  );
  if (length === 3) expect((await pending).byteLength).toBe(3);
  else await expect(pending).rejects.toThrow("byte limit");
});

test("discards declared oversized and unread bodies without waiting for cancellation", async () => {
  for (const oversized of [true, false]) {
    const cancel = mock(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { "Content-Length": "100" },
    });
    const pending = withHttpTransport(
      { label: "Fixture", fetch: async () => response },
      async (http) => {
        await http.fetch("https://example.test");
        if (oversized) await http.readBody(response, { maxBytes: 3, signal: signal() });
      },
    );
    if (oversized) await expect(pending).rejects.toThrow("byte limit");
    else await pending;
    expect(cancel).toHaveBeenCalledTimes(1);
  }
});

test.each([
  ["Proxy Authentication Required (407)", true, 407],
  ["Unrelated invalid argument", true, undefined],
  ["Proxy Authentication Required (407)", false, undefined],
  ["Proxy refused to open a tunnel: 502 Rejected", false, undefined],
] as const)(
  "classifies proxy failures only on a proxy route: %s (%s)",
  async (message, proxied, status) => {
    if (proxied) {
      delete process.env.no_proxy;
      process.env.https_proxy = "http://alice:private-secret@localhost:8000";
    }
    const cause = Object.assign(new Error(message), { code: "UND_ERR_INVALID_ARG" });
    const error = await withHttpTransport(
      {
        label: "Fixture",
        fetch: async () => {
          throw new TypeError("private-secret", { cause });
        },
      },
      (http) => http.fetch("https://example.test"),
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(HttpNetworkError);
    expect((error as HttpNetworkError).proxyStatus).toBe(status);
    expect((error as HttpNetworkError).code).toBe(
      status === 407 ? "ERR_PROXY_AUTH" : "UND_ERR_INVALID_ARG",
    );
    expect((error as HttpNetworkError).cause).toBeInstanceOf(TypeError);
    expect(String(error)).not.toMatch(/alice|private-secret/);
  },
);
