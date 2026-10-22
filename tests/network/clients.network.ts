import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createClient as createArxiv } from "../../extensions/pi-arxiv/src/client.ts";
import { createClient as createWeb } from "../../extensions/pi-web-fetch/src/client.ts";
import { createFetcher } from "../../extensions/pi-web-fetch/src/fetch.ts";
import { createClient as createWikipedia } from "../../extensions/pi-wikipedia/src/client.ts";
import { environment, origin, proxy } from "../../packages/http/tests/fixtures/network.ts";

environment();
afterEach(() => environment());

for (const direction of ["proxy-to-direct", "direct-to-proxy"] as const) {
  test(
    `web redirects ${direction} and sends validators only to their target`,
    { timeout: 5000 },
    async (t) => {
      const requests: { path: string | undefined; validator: string | undefined }[] = [];
      const destination = await origin((req, res) => {
        requests.push({ path: req.url, validator: req.headers["if-none-match"] });
        res.end("destination");
      });
      t.after(() => destination.close());
      const redirector = await origin((req, res) => {
        requests.push({ path: req.url, validator: req.headers["if-none-match"] });
        res.writeHead(302, { Location: `${destination.url}/final` });
        res.end();
      });
      t.after(() => redirector.close());
      const gateway = await proxy();
      t.after(() => gateway.close());
      const bypass = direction === "proxy-to-direct" ? destination : redirector;
      environment({ HTTP_PROXY: gateway.url, NO_PROXY: `127.0.0.1:${bypass.port}` });
      const request = createWeb({ minIntervalMs: 0, timeoutMs: 3000 });
      const result = await request(
        `${redirector.url}/start`,
        { "If-None-Match": '"cached"' },
        undefined,
        `${destination.url}/final`,
      );
      assert.equal(result.finalUrl, `${destination.url}/final`);
      assert.equal(new TextDecoder().decode(result.body), "destination");
      assert.deepEqual(requests, [
        { path: "/start", validator: undefined },
        { path: "/final", validator: '"cached"' },
      ]);
      assert.deepEqual(
        gateway.records.map((record) => record.target),
        [direction === "proxy-to-direct" ? `${redirector.url}/start` : `${destination.url}/final`],
      );
    },
  );
}

for (const failure of ["authentication", "body"] as const) {
  test(`web stale warnings preserve safe ${failure} diagnostics`, { timeout: 5000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "web-network-cache-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let broken = false;
    let reached = 0;
    const target = await origin((req, res) => {
      reached++;
      res.writeHead(200, {
        "Content-Type": "text/plain",
        ...(broken ? { "Content-Length": "100" } : {}),
      });
      if (broken) res.end("partial", () => req.socket.end());
      else res.end("cached document");
    });
    t.after(() => target.close());
    const settings = { auth: `Basic ${Buffer.from("alice:private-secret").toString("base64")}` };
    const gateway = await proxy(settings);
    t.after(() => gateway.close());
    environment({ HTTP_PROXY: gateway.url.replace("://", "://alice:private-secret@") });
    const fetch = createFetcher(root, createWeb({ minIntervalMs: 0, timeoutMs: 3000 }));
    const seeded = await fetch({ url: target.url });
    assert.equal(seeded.cache, "miss");
    if (failure === "authentication") settings.auth = "Basic rejected";
    else broken = true;
    const stale = await fetch({ url: target.url, refresh: true });
    assert.equal(stale.cache, "stale");
    assert.equal(stale.content, seeded.content);
    assert.equal(stale.validatedAt, seeded.validatedAt);
    assert.match(stale.warning!, /Route: environment proxy/);
    assert.match(
      stale.warning!,
      failure === "authentication"
        ? /authentication required \(HTTP 407\)/
        : /response body could not be downloaded/,
    );
    assert.doesNotMatch(JSON.stringify(stale), /alice|private-secret|YWxpY2U6/);
    assert.equal(reached, failure === "authentication" ? 1 : 2);
    assert.equal(gateway.records.length, 2);
  });
}

test(
  "web cancellation through a proxy rejects instead of returning stale content",
  { timeout: 5000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "web-network-cancel-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const ready = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let stall = false;
    const target = await origin((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      if (stall) {
        req.socket.once("close", () => closed.resolve());
        res.flushHeaders();
        ready.resolve();
      } else res.end("cached document");
    });
    t.after(() => target.close());
    const gateway = await proxy();
    t.after(() => gateway.close());
    environment({ HTTP_PROXY: gateway.url });
    const fetch = createFetcher(root, createWeb({ minIntervalMs: 0, timeoutMs: 3000 }));
    const seeded = await fetch({ url: target.url });
    stall = true;
    const owner = new AbortController();
    t.after(() => owner.abort());
    const pending = fetch({ url: target.url, refresh: true }, owner.signal);
    const rejected = assert.rejects(pending, (error: unknown) => error === owner.signal.reason);
    await ready.promise;
    owner.abort();
    await rejected;
    await closed.promise;
    const cached = await fetch({ url: target.url });
    assert.equal(cached.cache, "hit");
    assert.equal(cached.validatedAt, seeded.validatedAt);
    assert.equal(gateway.records.length, 2);
  },
);

test(
  "Wikipedia search and page clients use an authenticated proxy without leaking authorization",
  { timeout: 5000 },
  async (t) => {
    const paths: string[] = [];
    const target = await origin((req, res) => {
      paths.push(req.url!);
      assert.equal(req.headers.host, "en.wikipedia.org");
      assert.equal(req.headers["proxy-authorization"], undefined);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ fixture: req.url }));
    }, true);
    t.after(() => target.close());
    const authorization = `Basic ${Buffer.from("alice:private-secret").toString("base64")}`;
    const gateway = await proxy({ targetPort: target.port, auth: authorization });
    t.after(() => gateway.close());
    environment({ HTTPS_PROXY: gateway.url.replace("://", "://alice:private-secret@") });
    const request = createWikipedia({ intervalMs: 0, timeoutMs: 3000 });
    for (const path of ["/search/page?q=fixture", "/page/Fixture"]) {
      assert.deepEqual(await request(path), { fixture: `/w/rest.php/v1${path}` });
    }
    assert.deepEqual(paths, [
      "/w/rest.php/v1/search/page?q=fixture",
      "/w/rest.php/v1/page/Fixture",
    ]);
    assert.deepEqual(gateway.records, [
      { target: "en.wikipedia.org:443", authorization },
      { target: "en.wikipedia.org:443", authorization },
    ]);
  },
);

test(
  "Wikipedia proxy failures retain actionable diagnostics and the queue recovers",
  { timeout: 5000 },
  async (t) => {
    let reached = 0;
    const target = await origin((_req, res) => {
      reached++;
      res.end('{"source":"recovered"}');
    }, true);
    t.after(() => target.close());
    const settings = { targetPort: target.port, status: 407 };
    const gateway = await proxy(settings);
    t.after(() => gateway.close());
    environment({ HTTPS_PROXY: gateway.url.replace("://", "://alice:private-secret@") });
    const request = createWikipedia({ intervalMs: 0, timeoutMs: 3000 });
    const failed = assert.rejects(request("/page/Fixture"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /authentication required \(HTTP 407\)/);
      assert.match(error.message, /ERR_PROXY_AUTH/);
      assert.match(error.message, /Route: environment proxy/);
      assert.doesNotMatch(error.message, /alice|private-secret|no HTTP response|cause is unknown/);
      return true;
    });
    await failed;
    assert.equal(reached, 0);
    settings.status = 200;
    assert.deepEqual(await request("/page/Fixture"), { source: "recovered" });
    assert.equal(reached, 1);
    assert.equal(gateway.records.length, 2);
  },
);

test(
  "Wikipedia body cancellation through a proxy releases the queue",
  { timeout: 5000 },
  async (t) => {
    const ready = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let reached = 0;
    const target = await origin((req, res) => {
      if (++reached === 1) {
        req.socket.once("close", () => closed.resolve());
        res.writeHead(200);
        res.flushHeaders();
        ready.resolve();
      } else res.end('{"source":"recovered"}');
    }, true);
    t.after(() => target.close());
    const gateway = await proxy({ targetPort: target.port });
    t.after(() => gateway.close());
    environment({ HTTPS_PROXY: gateway.url });
    const request = createWikipedia({ intervalMs: 0, timeoutMs: 3000 });
    const owner = new AbortController();
    t.after(() => owner.abort());
    const rejected = assert.rejects(request("/page/Fixture", owner.signal), /cancelled/);
    const queued = request("/page/Next");
    await ready.promise;
    owner.abort();
    await rejected;
    await closed.promise;
    assert.deepEqual(await queued, { source: "recovered" });
    assert.equal(gateway.records.length, 2);
  },
);

test("arXiv API and PDF clients use an authenticated proxy", { timeout: 5000 }, async (t) => {
  const requests: { host: string | undefined; path: string | undefined }[] = [];
  const target = await origin((req, res) => {
    requests.push({ host: req.headers.host, path: req.url });
    assert.equal(req.headers["proxy-authorization"], undefined);
    res.end(req.url?.startsWith("/pdf/") ? "%PDF-fixture" : "<feed/>");
  }, true);
  t.after(() => target.close());
  const authorization = `Basic ${Buffer.from("alice:private-secret").toString("base64")}`;
  const gateway = await proxy({ targetPort: target.port, auth: authorization });
  t.after(() => gateway.close());
  environment({ HTTPS_PROXY: gateway.url.replace("://", "://alice:private-secret@") });
  const request = createArxiv({ sleep: async () => {}, timeoutMs: 3000 });
  assert.equal(
    (await request("https://export.arxiv.org/api/query?search_query=fixture")).toString(),
    "<feed/>",
  );
  assert.equal((await request("https://arxiv.org/pdf/1706.03762")).toString(), "%PDF-fixture");
  assert.deepEqual(requests, [
    { host: "export.arxiv.org", path: "/api/query?search_query=fixture" },
    { host: "arxiv.org", path: "/pdf/1706.03762" },
  ]);
  assert.deepEqual(gateway.records, [
    { target: "export.arxiv.org:443", authorization },
    { target: "arxiv.org:443", authorization },
  ]);
});

for (const status of [301, 302, 303, 307, 308]) {
  test(
    `arXiv reports HTTP ${status} without following redirects and recovers`,
    { timeout: 5000 },
    async (t) => {
      const paths: string[] = [];
      const closed = Promise.withResolvers<void>();
      const target = await origin((req, res) => {
        paths.push(req.url!);
        if (paths.length === 1) {
          req.socket.once("close", () => closed.resolve());
          res.writeHead(status, { Location: "https://arxiv.org/pdf/redirected?private-secret" });
          res.flushHeaders();
        } else res.end("%PDF-recovered");
      }, true);
      t.after(() => target.close());
      const gateway = await proxy({ targetPort: target.port });
      t.after(() => gateway.close());
      environment({ HTTPS_PROXY: gateway.url });
      const request = createArxiv({ sleep: async () => {}, timeoutMs: 3000 });
      const rejected = assert.rejects(
        request("https://arxiv.org/pdf/1706.03762"),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            new RegExp(`arXiv HTTP ${status}: redirects are not supported`),
          );
          assert.doesNotMatch(error.message, /no HTTP response|private-secret/);
          return true;
        },
      );
      const queued = request("https://arxiv.org/pdf/1706.03762v1");
      await rejected;
      await closed.promise;
      assert.equal((await queued).toString(), "%PDF-recovered");
      assert.deepEqual(paths, ["/pdf/1706.03762", "/pdf/1706.03762v1"]);
      assert.equal(gateway.records.length, 2);
    },
  );
}
