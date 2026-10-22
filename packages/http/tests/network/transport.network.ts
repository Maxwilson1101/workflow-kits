import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { HttpNetworkError, withHttpTransport } from "../../src/index.ts";
import { environment, origin, proxy } from "../fixtures/network.ts";

environment();
afterEach(() => environment());

async function download(url: string, signal = AbortSignal.timeout(3000)) {
  return withHttpTransport({ label: "Fixture" }, async (http) => {
    const response = await http.fetch(url, { signal, headers: { "X-Fixture": "request" } });
    return new TextDecoder().decode(await http.readBody(response, { signal, maxBytes: 1000 }));
  });
}

for (const secure of [false, true]) {
  for (const secureProxy of [false, true]) {
    test(
      `real ${secure ? "HTTPS" : "HTTP"} through ${secureProxy ? "HTTPS" : "HTTP"} proxy with authentication`,
      { timeout: 5000 },
      async (t) => {
        const requests: {
          url: string | undefined;
          auth: string | undefined;
          header: string | string[] | undefined;
        }[] = [];
        const target = await origin((req, res) => {
          requests.push({
            url: req.url,
            auth: req.headers["proxy-authorization"],
            header: req.headers["x-fixture"],
          });
          res.end("fixture");
        }, secure);
        t.after(() => target.close());
        const gateway = await proxy({
          auth: `Basic ${Buffer.from("alice:p@ssword").toString("base64")}`,
          secure: secureProxy,
        });
        t.after(() => gateway.close());
        const configured = new URL(gateway.url);
        configured.username = "alice";
        configured.password = "p@ssword";
        environment({ ALL_PROXY: configured.href });
        assert.equal(await download(`${target.url}/document`), "fixture");
        assert.equal(gateway.records.length, 1);
        assert.equal(
          gateway.records[0]?.target,
          secure ? `localhost:${target.port}` : `${target.url}/document`,
        );
        assert.deepEqual(requests, [{ url: "/document", auth: undefined, header: "request" }]);
      },
    );
  }
}

test("NO_PROXY bypasses a configured rejecting proxy", { timeout: 5000 }, async (t) => {
  let count = 0;
  const target = await origin((_req, res) => {
    count++;
    res.end("direct");
  });
  t.after(() => target.close());
  const gateway = await proxy({ status: 502 });
  t.after(() => gateway.close());
  environment({ HTTP_PROXY: gateway.url, NO_PROXY: `127.0.0.1:${target.port}` });
  assert.equal(await download(target.url), "direct");
  assert.equal(count, 1);
  assert.equal(gateway.records.length, 0);
});

for (const [status, expected] of [
  [407, /authentication required \(HTTP 407\)/],
  [502, /refused the tunnel \(HTTP 502\)/],
] as const) {
  test(
    `CONNECT HTTP ${status} fails without direct fallback or credential disclosure`,
    { timeout: 5000 },
    async (t) => {
      let reached = 0;
      const target = await origin((_req, res) => {
        reached++;
        res.end("must not arrive");
      }, true);
      t.after(() => target.close());
      const gateway = await proxy({ status });
      t.after(() => gateway.close());
      environment({ HTTPS_PROXY: gateway.url.replace("://", "://alice:private-secret@") });
      await assert.rejects(download(target.url), (error: unknown) => {
        assert.ok(error instanceof HttpNetworkError);
        assert.equal(error.phase, "request");
        assert.equal(error.proxyStatus, status);
        assert.match(error.message, expected);
        assert.match(error.message, /Route: environment proxy/);
        assert.doesNotMatch(error.message, /alice|private-secret/);
        return true;
      });
      assert.equal(reached, 0);
      assert.equal(gateway.records.length, 1);
    },
  );
}

test("refused proxy connection does not fall back to direct", { timeout: 5000 }, async (t) => {
  let reached = 0;
  const target = await origin((_req, res) => {
    reached++;
    res.end("must not arrive");
  });
  t.after(() => target.close());
  const gateway = await proxy();
  await gateway.close();
  environment({ HTTP_PROXY: gateway.url });
  await assert.rejects(download(target.url), (error: unknown) => {
    assert.ok(error instanceof HttpNetworkError);
    assert.equal(error.code, "ECONNREFUSED");
    return true;
  });
  assert.equal(reached, 0);
});

for (const kind of ["cancel", "timeout"] as const) {
  for (const phase of ["request", "body"] as const) {
    test(
      `${kind} after observable ${phase} readiness terminates actual network work`,
      { timeout: 5000 },
      async (t) => {
        const ready = Promise.withResolvers<void>();
        const closed = Promise.withResolvers<void>();
        const owner = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const target = await origin((req, res) => {
          req.socket.on("close", () => closed.resolve());
          if (phase === "body") {
            res.writeHead(200);
            res.flushHeaders();
          } else ready.resolve();
        });
        t.after(() => target.close());
        t.after(() => {
          clearTimeout(timer);
          owner.abort();
        });
        const pending = withHttpTransport({ label: "Fixture" }, async (http) => {
          const response = await http.fetch(target.url, { signal: owner.signal });
          ready.resolve();
          return http.readBody(response, { maxBytes: 100, signal: owner.signal });
        });
        const outcome = pending.catch((error: unknown) => error);
        await ready.promise;
        if (kind === "cancel") owner.abort();
        else
          timer = setTimeout(() => owner.abort(new DOMException("Deadline", "TimeoutError")), 10);
        assert.equal(await outcome, owner.signal.reason);
        await closed.promise;
      },
    );
  }
}

test(
  "premature response EOF is a body failure, not a headers failure",
  { timeout: 5000 },
  async (t) => {
    let end!: () => void;
    const target = await origin((req, res) => {
      res.writeHead(200, { "Content-Length": "100" });
      res.write("partial");
      end = () => req.socket.end();
    });
    t.after(() => target.close());
    await assert.rejects(
      withHttpTransport({ label: "Fixture" }, async (http) => {
        const signal = AbortSignal.timeout(3000);
        const response = await http.fetch(target.url, { signal });
        end();
        return http.readBody(response, { maxBytes: 100, signal });
      }),
      (error: unknown) => {
        assert.ok(error instanceof HttpNetworkError);
        assert.equal(error.phase, "body");
        return true;
      },
    );
  },
);
